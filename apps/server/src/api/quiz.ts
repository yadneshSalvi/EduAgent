import type { FastifyPluginAsync } from 'fastify';
import { submitQuizRequestSchema, type QuizPayload, type SubmitQuizRequest } from '@eduagent/shared';
import { findQuizForUser } from '../relay/index.js';
import { sendError } from './http.js';

/**
 * Quiz pipeline (plans/03 §7): submissions carry ALL answers, including the
 * client-checked mcq/predict_output verdicts — the agent needs them as
 * mastery evidence. The grading turn (system role, same thread the quiz was
 * pushed on) has the agent grade the short answers via ui_grade_quiz, record
 * the assessment, and commit. Results arrive via WS (`quiz.graded`).
 */

/** ~Answers are learner input; cap what gets inlined into the turn. */
const ANSWER_INLINE_MAX = 2_000;
const PROMPT_RECAP_MAX = 240;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function buildQuizGradingTurn(
  quiz: QuizPayload,
  answers: SubmitQuizRequest['answers'],
): string {
  const byId = new Map(quiz.questions.map((q) => [q.id, q]));
  const answerLines = answers.flatMap((answer) => {
    const question = byId.get(answer.question_id);
    const header =
      `- ${answer.question_id} (${question?.type ?? 'unknown'})` +
      (answer.verdict !== undefined ? ` — instant-checked: ${answer.verdict}` : '');
    const recap = question ? `  Q: ${clip(question.prompt_md, PROMPT_RECAP_MAX)}` : null;
    const given = `  Learner answered: ${clip(answer.answer, ANSWER_INLINE_MAX) || '(blank)'}`;
    return recap === null ? [header, given] : [header, recap, given];
  });

  const shortIds = answers
    .filter((a) => byId.get(a.question_id)?.type === 'short')
    .map((a) => a.question_id);

  return [
    `The learner submitted quiz ${quiz.id}. Their answers, with instant-checked verdicts for`,
    'mcq/predict_output questions (checked in the UI against the answers you provided —',
    'treat them as evidence):',
    '',
    ...answerLines,
    '',
    `1. Grade ${shortIds.length > 0 ? `the short answer${shortIds.length === 1 ? '' : 's'} (${shortIds.join(', ')})` : 'the results'} ` +
      `and call ui_grade_quiz (quiz_id "${quiz.id}") with a verdict and feedback per graded question.`,
    '2. Discuss the results briefly in chat — reinforce what was right, untangle what was',
    '   wrong. No new lesson; one targeted follow-up question is fine.',
    '3. Update the learner model and git commit per the memory skill, and mirror the change',
    '   with ui_record_assessment.',
  ].join('\n');
}

export const quizRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/quiz/:id/submit', async (req, reply) => {
    const authed = await app.resolveUser(req);
    if (!authed) return sendError(reply, 401, 'unauthenticated');
    if (!app.threads) {
      return sendError(reply, 503, 'not_ready', 'The agent backend has not finished booting.');
    }
    const body = submitQuizRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        'invalid_body',
        body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }

    const { id } = req.params as { id: string };
    const quiz = await findQuizForUser(app.prisma, authed.userId, id);
    if (!quiz) return sendError(reply, 404, 'not_found', 'No such quiz.');
    const thread = await app.prisma.thread.findUnique({ where: { id: quiz.threadId } });
    if (!thread || thread.userId !== authed.userId) {
      return sendError(reply, 404, 'not_found', 'No such quiz.');
    }
    const validIds = new Set(quiz.payload.questions.map((q) => q.id));
    const unknown = body.data.answers.filter((a) => !validIds.has(a.question_id));
    if (unknown.length > 0) {
      return sendError(
        reply,
        400,
        'invalid_body',
        `Unknown question ids: ${unknown.map((a) => a.question_id).join(', ')}.`,
      );
    }

    const turnText = buildQuizGradingTurn(quiz.payload, body.data.answers);
    const threads = app.threads;
    const gateway = app.wsGateway;
    const emitGradingError = (message: string) => {
      gateway?.emitToThread(thread.id, {
        type: 'turn.error',
        threadId: thread.id,
        message,
        retryable: true,
      });
    };
    const submittedAt = new Date();
    threads
      .startSystemTurn(thread, turnText, {
        caption: 'Quiz answers submitted — the tutor graded them.',
      })
      .then(
        async () => {
          // The relay records a `quiz_graded` ActivityEvent when the agent
          // calls ui_grade_quiz; a settled turn with no such event means the
          // quiz card would sit on "grading…" forever — hand control back.
          const events = await app.prisma.activityEvent.findMany({
            where: { userId: authed.userId, kind: 'quiz_graded', at: { gte: submittedAt } },
            orderBy: { at: 'desc' },
            take: 50,
          });
          const graded = events.some((event) => {
            const meta = event.meta as { quizId?: unknown } | null;
            return typeof meta === 'object' && meta !== null && meta.quizId === id;
          });
          if (!graded) {
            emitGradingError('The tutor finished without grading this quiz. Submit again.');
          }
        },
        async (err: unknown) => {
          req.log.error({ err, quizId: id, threadId: thread.id }, 'quiz grading turn failed');
          emitGradingError('Quiz grading could not start. Submit again in a moment.');
        },
      )
      .catch((err: unknown) => {
        req.log.error({ err, quizId: id }, 'quiz grading reconciliation failed');
      });

    return { ok: true as const };
  });
};
