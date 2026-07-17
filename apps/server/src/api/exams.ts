import type { Exam } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  createExamRequestSchema,
  examAnswersSchema,
  examQuestionsSchema,
  examResultSchema,
  saveExamAnswersRequestSchema,
  submitExamRequestSchema,
  type CreateExamResponse,
  type ExamDto,
  type ExamSummary,
  type ListExamsResponse,
  type StartExamResponse,
} from '@eduagent/shared';
import {
  DeadlinePassedError,
  ExamStateError,
  parseExamConfig,
  UnknownTrackError,
} from '../learning/index.js';
import { sendError } from './http.js';

/**
 * Exam lifecycle routes (plans/03 §7). Every route resolves the authed user
 * and only ever touches THAT user's exams (ExamService.get enforces
 * ownership). The DTO never carries answer keys or hidden-test paths — the
 * shared exam schemas contain neither by construction — and `questions` stay
 * null until the exam is `ready`.
 */
export const examRoutes: FastifyPluginAsync = async (app) => {
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const authed = await app.resolveUser(req);
    if (!authed) {
      await sendError(reply, 401, 'unauthenticated');
      return null;
    }
    return authed;
  };

  const requireService = async (reply: FastifyReply) => {
    if (!app.exams) {
      await sendError(reply, 503, 'not_ready', 'The exam service has not finished booting.');
      return null;
    }
    return app.exams;
  };

  const examId = (req: FastifyRequest): string => (req.params as { id: string }).id;

  const mapError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (err instanceof UnknownTrackError) {
      return sendError(reply, 404, 'unknown_track', err.message);
    }
    if (err instanceof DeadlinePassedError) {
      return sendError(reply, 409, 'deadline_passed', err.message);
    }
    if (err instanceof ExamStateError) {
      return sendError(reply, 409, 'invalid_state', err.message);
    }
    throw err;
  };

  app.post('/api/exams', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exams = await requireService(reply);
    if (!exams) return reply;
    const body = createExamRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', zodIssues(body.error));
    }
    try {
      const created = await exams.create(authed.userId, body.data);
      const response: CreateExamResponse = created;
      return response;
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get('/api/exams', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exams = await requireService(reply);
    if (!exams) return reply;
    const rows = await exams.list(authed.userId);
    const response: ListExamsResponse = { exams: rows.map(toExamSummary) };
    return response;
  });

  app.get('/api/exams/:id', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exams = await requireService(reply);
    if (!exams) return reply;
    const exam = await exams.get(authed.userId, examId(req));
    if (exam === null) return sendError(reply, 404, 'not_found', 'No such exam.');
    return toExamDto(exam);
  });

  app.post('/api/exams/:id/start', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exams = await requireService(reply);
    if (!exams) return reply;
    try {
      const started = await exams.start(authed.userId, examId(req));
      if (started === null) return sendError(reply, 404, 'not_found', 'No such exam.');
      const response: StartExamResponse = {
        startedAt: started.startedAt.toISOString(),
        deadline: started.deadline.toISOString(),
      };
      return response;
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.put('/api/exams/:id/answers', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exams = await requireService(reply);
    if (!exams) return reply;
    const body = saveExamAnswersRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', zodIssues(body.error));
    }
    try {
      const exam = await exams.autosave(authed.userId, examId(req), body.data.answers);
      if (exam === null) return sendError(reply, 404, 'not_found', 'No such exam.');
      return { ok: true as const };
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post('/api/exams/:id/submit', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const exams = await requireService(reply);
    if (!exams) return reply;
    const body = submitExamRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', zodIssues(body.error));
    }
    try {
      const submitted = await exams.submit(authed.userId, examId(req), body.data.answers);
      if (submitted === null) return sendError(reply, 404, 'not_found', 'No such exam.');
      return { ok: true as const };
    } catch (err) {
      return mapError(reply, err);
    }
  });
};

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

function toExamSummary(exam: Exam): ExamSummary {
  const config = parseExamConfig(exam.config);
  return {
    id: exam.id,
    trackSlug: exam.trackSlug,
    status: exam.status as ExamSummary['status'],
    durationMin: config.durationMin,
    startedAt: exam.startedAt?.toISOString() ?? null,
    submittedAt: exam.submittedAt?.toISOString() ?? null,
    gradedAt: exam.gradedAt?.toISOString() ?? null,
    createdAt: exam.createdAt.toISOString(),
  };
}

/**
 * Draft exams expose no questions (generation may still be writing them);
 * stored payloads re-parse through the shared schemas so nothing beyond the
 * contract can ever ride along.
 */
export function toExamDto(exam: Exam): ExamDto {
  return {
    ...toExamSummary(exam),
    questions:
      exam.status === 'draft' ? null : examQuestionsSchema.parse(exam.questions),
    answers: exam.answers === null ? null : examAnswersSchema.parse(exam.answers),
    result: exam.result === null ? null : examResultSchema.parse(exam.result),
  };
}
