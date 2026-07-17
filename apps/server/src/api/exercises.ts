import fs from 'node:fs/promises';
import path from 'node:path';
import type { Exercise, ExerciseAttempt } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  submitExerciseRequestSchema,
  type ExerciseDto,
  type SubmitExerciseResponse,
} from '@eduagent/shared';
import { sendError } from './http.js';

/**
 * Exercise pipeline (plans/03 §3.5, §7): the relay persisted the Exercise row
 * when the agent pushed it; these routes read it back and turn submissions
 * into grading turns on the SAME thread. The verdict arrives via WS
 * (`exercise.graded`) — the submit response only acknowledges the attempt.
 */

/** Submission filename extension per exercise language (fallback: txt). */
const LANGUAGE_EXTENSIONS: Record<string, string> = {
  python: 'py',
  python3: 'py',
  javascript: 'js',
  typescript: 'ts',
  sql: 'sql',
  go: 'go',
  rust: 'rs',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  csharp: 'cs',
  ruby: 'rb',
  php: 'php',
  bash: 'sh',
  shell: 'sh',
};

export function submissionRelPath(exerciseSlug: string, language: string): string {
  const ext = LANGUAGE_EXTENSIONS[language.toLowerCase()] ?? 'txt';
  return path.posix.join('.exercises', exerciseSlug, `submission.${ext}`);
}

/** Above this the code still lands on disk but is not inlined into the turn. */
const INLINE_CODE_MAX = 8_000;

/**
 * The grading-turn input (system role — never rendered as a learner message).
 * Wording mirrors the teach skill's grading flow so the instructions and the
 * skill reinforce each other rather than drift.
 */
export function buildExerciseGradingTurn(opts: {
  exerciseSlug: string;
  language: string;
  attemptNumber: number;
  submissionPath: string;
  code: string;
}): string {
  const lines = [
    `The learner submitted their solution for exercise ${opts.exerciseSlug} ` +
      `(attempt ${opts.attemptNumber}). It is saved at \`${opts.submissionPath}\` in your workspace.`,
    '',
    `1. Run the hidden tests in \`.exercises/${opts.exerciseSlug}/tests/\` against the submission`,
    '   in your sandbox — actually execute them; never infer a verdict from reading the code.',
    `2. Call ui_grade_exercise (exercise_id "${opts.exerciseSlug}") with the verdict and feedback`,
    '   per the teach skill: what passed, what failed and why, one targeted hint — never the',
    '   full solution on a first failure.',
    '3. Give the learner the feedback in chat, in your normal voice.',
    '4. Update the learner model and git commit per the memory skill, and mirror the change',
    '   with ui_record_assessment.',
  ];
  if (opts.code.length <= INLINE_CODE_MAX) {
    lines.push('', 'The submission, verbatim:', '', '```' + opts.language, opts.code, '```');
  }
  return lines.join('\n');
}

export const exerciseRoutes: FastifyPluginAsync = async (app) => {
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const authed = await app.resolveUser(req);
    if (!authed) {
      await sendError(reply, 401, 'unauthenticated');
      return null;
    }
    return authed;
  };

  /** The exercise (client-facing :id = per-user slug), or null after a 404 reply. */
  const ownedExercise = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const { id } = req.params as { id: string };
    const exercise = await app.prisma.exercise.findUnique({
      where: { userId_slug: { userId, slug: id } },
      include: { attempts: { orderBy: { createdAt: 'asc' } } },
    });
    if (!exercise) {
      await sendError(reply, 404, 'not_found', 'No such exercise.');
      return null;
    }
    return exercise;
  };

  app.get('/api/exercises/:id', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exercise = await ownedExercise(req, reply, authed.userId);
    if (!exercise) return reply;
    return toExerciseDto(exercise);
  });

  app.post('/api/exercises/:id/submit', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    if (!app.threads || !app.workspaces) {
      return sendError(reply, 503, 'not_ready', 'The agent backend has not finished booting.');
    }
    const exercise = await ownedExercise(req, reply, authed.userId);
    if (!exercise) return reply;
    const body = submitExerciseRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(
        reply,
        400,
        'invalid_body',
        body.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      );
    }
    const thread = await app.prisma.thread.findUnique({ where: { id: exercise.threadId } });
    if (!thread) {
      return sendError(reply, 409, 'thread_missing', 'This exercise has no tutoring thread.');
    }
    const pending = exercise.attempts.some((a) => a.verdict === null);
    if (pending) {
      return sendError(
        reply,
        409,
        'grading_in_progress',
        'Your previous submission is still being graded — the verdict will appear shortly.',
      );
    }

    // The submission lands in the exercise workdir so the agent can run the
    // hidden tests against it inside its own sandbox (plans/01 §5.2).
    const relPath = submissionRelPath(exercise.slug, exercise.language);
    const absPath = path.join(app.workspaces.pathFor(authed.userId), relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, body.data.code, 'utf8');

    const attempt = await app.prisma.exerciseAttempt.create({
      data: { exerciseId: exercise.id, code: body.data.code },
    });

    const turnText = buildExerciseGradingTurn({
      exerciseSlug: exercise.slug,
      language: exercise.language,
      attemptNumber: exercise.attempts.length + 1,
      submissionPath: relPath,
      code: body.data.code,
    });
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
    // A verdict:null attempt 409-blocks every future submit, so once the
    // grading turn settles (or fails to start) an attempt nothing graded is
    // marked `error` — otherwise one dropped ui_grade_exercise call would
    // wedge the exercise forever.
    const reconcileUngradedAttempt = () =>
      app.prisma.exerciseAttempt.updateMany({
        where: { id: attempt.id, verdict: null },
        data: { verdict: 'error', gradedAt: new Date() },
      });
    threads
      .startSystemTurn(thread, turnText, {
        caption: `Attempt ${exercise.attempts.length + 1} on ${exercise.slug} submitted — the tutor ran the hidden tests.`,
      })
      .then(
        async () => {
          const orphaned = await reconcileUngradedAttempt();
          if (orphaned.count > 0) {
            emitGradingError('The tutor finished without delivering a verdict. Submit again.');
          }
        },
        async (err: unknown) => {
          req.log.error(
            { err, exercise: exercise.slug, threadId: thread.id },
            'grading turn failed',
          );
          await reconcileUngradedAttempt();
          emitGradingError('Grading could not start. Submit again in a moment.');
        },
      )
      .catch((err: unknown) => {
        req.log.error({ err, exercise: exercise.slug }, 'attempt reconciliation failed');
      });

    const response: SubmitExerciseResponse = { ok: true, attemptId: attempt.id };
    return response;
  });
};

function toExerciseDto(exercise: Exercise & { attempts: ExerciseAttempt[] }): ExerciseDto {
  return {
    id: exercise.slug,
    threadId: exercise.threadId,
    language: exercise.language,
    title: exercise.title,
    prompt: exercise.prompt,
    starterCode: exercise.starterCode,
    concepts: exercise.concepts as string[],
    difficulty: exercise.difficulty as ExerciseDto['difficulty'],
    status: exercise.status as ExerciseDto['status'],
    createdAt: exercise.createdAt.toISOString(),
    attempts: exercise.attempts.map((attempt) => ({
      id: attempt.id,
      code: attempt.code,
      verdict: attempt.verdict as 'passed' | 'failed' | 'error' | null,
      feedback: attempt.feedback,
      createdAt: attempt.createdAt.toISOString(),
      gradedAt: attempt.gradedAt?.toISOString() ?? null,
    })),
  };
}
