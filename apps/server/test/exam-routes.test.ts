import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient, Thread } from '@prisma/client';
import type { DashboardData, ThreadMode, WsEvent } from '@eduagent/shared';
import {
  createExamResponseSchema,
  examDtoSchema,
  listExamsResponseSchema,
  startExamResponseSchema,
} from '@eduagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { ExamService } from '../src/learning/index.js';
import type { EnsureThreadResult, ExamForkOptions, ExamThreadService } from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * Exam REST routes (plans/03 §7) over a REAL ExamService (fake threads +
 * dashboard): shared response shapes, zod-validated bodies, ownership 404s,
 * state-machine 409s, and the no-leak rule — the DTO must never expose more
 * than the shared exam schemas define (no answer keys, no test paths).
 */

const TRACK = 'sql-interview';

class FakeThreadService implements ExamThreadService {
  constructor(private readonly prisma: PrismaClient) {}
  async ensureThread(userId: string, mode: ThreadMode): Promise<EnsureThreadResult> {
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: `cdx-${Date.now()}-${Math.random()}`,
        mode,
        title: 'ensured',
        sessionToken: `tok-${Date.now()}-${Math.random()}`,
      },
    });
    return { thread, created: true };
  }
  async forkForExam(parent: Thread, opts: ExamForkOptions): Promise<Thread> {
    return this.prisma.thread.create({
      data: {
        userId: parent.userId,
        codexThreadId: `cdx-fork-${Date.now()}-${Math.random()}`,
        mode: 'exam',
        trackSlug: opts.trackSlug,
        title: 'Mock exam',
        forkedFromId: parent.id,
        sessionToken: `tok-fork-${Date.now()}-${Math.random()}`,
      },
    });
  }
  invalidateInstructions(): void {}
  startTurn(): Promise<void> {
    return Promise.resolve();
  }
  startSystemTurn(): Promise<void> {
    return Promise.resolve();
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  turnInFlight(): boolean {
    return false;
  }
  inFlightThreads(): string[] {
    return [];
  }
  resumeAll(): Promise<void> {
    return Promise.resolve();
  }
}

const dashboardStub = {
  get(): Promise<DashboardData> {
    return Promise.resolve({
      user: { displayName: 'X', streakDays: 0 },
      readiness: [
        {
          track: TRACK,
          displayName: 'SQL',
          score: 52,
          delta7d: 0,
          weakest: [{ concept: 'left-join', name: 'LEFT JOIN', effective: 0.3 }],
        },
      ],
      topics: [],
      decaySeries: [],
      timeline: [],
      reviewQueue: { dueToday: 0, overdue: 0, nextConcepts: [] },
      activity: [],
    });
  },
};

const sinkStub = {
  emitToThread(_id: string, _event: WsEvent) {},
  emitToUser(_id: string, _event: WsEvent) {},
};

const QUESTIONS = {
  track: TRACK,
  duration_min: 30,
  sections: [
    {
      title: 'SQL',
      questions: [
        {
          id: 'q1',
          type: 'coding',
          prompt_md: 'Join things.',
          concepts: ['inner-join'],
          starter_code: 'SELECT 1;',
          language: 'sql',
          points: 10,
        },
        {
          id: 'q2',
          type: 'mcq',
          prompt_md: 'Rows?',
          concepts: ['left-join'],
          options: ['3', '5'],
          points: 5,
        },
      ],
    },
  ],
};

let app: FastifyInstance;
let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let exams: ExamService;
let cookie: string;
let otherCookie: string;

async function login(handle: string): Promise<{ id: string; cookie: string }> {
  const res = await app.inject({ method: 'POST', url: '/auth/local-login', payload: { handle } });
  expect(res.statusCode).toBe(200);
  return {
    id: (res.json() as { id: string }).id,
    cookie: String(res.headers['set-cookie']).split(';')[0]!,
  };
}

/** POST /api/exams for the main user, exam readied by direct row update. */
async function createReadyExam(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/exams',
    payload: { trackSlug: TRACK, durationMin: 30 },
    headers: { cookie },
  });
  expect(res.statusCode).toBe(200);
  const { examId } = createExamResponseSchema.parse(res.json());
  await prisma.exam.update({ where: { id: examId }, data: { questions: QUESTIONS, status: 'ready' } });
  return examId;
}

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('exam-routes');
  prisma = createPrisma(databaseUrl);
  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  const workspaces = new WorkspaceManager(dataDir.config);
  const threads = new FakeThreadService(prisma);
  exams = new ExamService({ prisma, workspaces, threads, dashboard: dashboardStub, sink: sinkStub });
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'exam-routes-test-secret',
    }),
    prisma,
    services: { exams },
  });
  await app.ready();
  const session = await login('exam-user');
  cookie = session.cookie;
  await new WorkspaceManager(dataDir.config).ensureWorkspace(session.id);
  const other = await login('exam-other');
  otherCookie = other.cookie;
  await new WorkspaceManager(dataDir.config).ensureWorkspace(other.id);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await cleanup();
});

describe('POST /api/exams', () => {
  it('requires auth and a valid body', async () => {
    const noAuth = await app.inject({
      method: 'POST',
      url: '/api/exams',
      payload: { trackSlug: TRACK, durationMin: 30 },
    });
    expect(noAuth.statusCode).toBe(401);

    const badBody = await app.inject({
      method: 'POST',
      url: '/api/exams',
      payload: { trackSlug: TRACK, durationMin: -5 },
      headers: { cookie },
    });
    expect(badBody.statusCode).toBe(400);
  });

  it('404s an unknown track', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/exams',
      payload: { trackSlug: 'no-such-track', durationMin: 30 },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'unknown_track' });
  });

  it('creates a draft exam', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/exams',
      payload: { trackSlug: TRACK, durationMin: 30 },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const created = createExamResponseSchema.parse(res.json());
    expect(created.status).toBe('draft');
  });
});

describe('GET /api/exams/:id', () => {
  it('hides questions while draft, serves them from ready on, and 404s other users', async () => {
    const examId = await createReadyExam();
    await prisma.exam.update({ where: { id: examId }, data: { status: 'draft' } });

    const draft = examDtoSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/exams/${examId}`, headers: { cookie } })).json(),
    );
    expect(draft.questions).toBeNull();
    expect(draft.durationMin).toBe(30);

    await prisma.exam.update({ where: { id: examId }, data: { status: 'ready' } });
    const ready = examDtoSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/exams/${examId}`, headers: { cookie } })).json(),
    );
    expect(ready.questions?.sections[0]?.questions).toHaveLength(2);

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/exams/${examId}`,
      headers: { cookie: otherCookie },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('never leaks fields beyond the shared schemas (answer keys, test paths)', async () => {
    const examId = await createReadyExam();
    // Simulate a hostile/buggy stored payload carrying extras the contract
    // doesn't know: the DTO must re-parse through the shared schemas and drop
    // them.
    const poisoned = structuredClone(QUESTIONS) as Record<string, unknown>;
    (poisoned.sections as Array<{ questions: Array<Record<string, unknown>> }>)[0]!.questions[0]!.answer_key =
      'SECRET';
    poisoned.tests_path = '.exercises/exam-x/tests/';
    await prisma.exam.update({
      where: { id: examId },
      data: { questions: poisoned as Prisma.InputJsonValue },
    });

    const res = await app.inject({ method: 'GET', url: `/api/exams/${examId}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const text = res.body;
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('answer_key');
    expect(text).not.toContain('tests_path');
  });
});

describe('exam lifecycle over HTTP', () => {
  it('start → autosave → submit, with state-machine 409s on wrong transitions', async () => {
    const examId = await createReadyExam();

    const early = await app.inject({
      method: 'POST',
      url: `/api/exams/${examId}/submit`,
      payload: { answers: {} },
      headers: { cookie },
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'invalid_state' });

    const started = startExamResponseSchema.parse(
      (
        await app.inject({ method: 'POST', url: `/api/exams/${examId}/start`, headers: { cookie } })
      ).json(),
    );
    expect(Date.parse(started.deadline) - Date.parse(started.startedAt)).toBe(30 * 60_000);

    const saved = await app.inject({
      method: 'PUT',
      url: `/api/exams/${examId}/answers`,
      payload: { answers: { q1: 'SELECT 42;' } },
      headers: { cookie },
    });
    expect(saved.statusCode).toBe(200);

    const submitted = await app.inject({
      method: 'POST',
      url: `/api/exams/${examId}/submit`,
      payload: { answers: { q1: 'SELECT 42;', q2: '5' } },
      headers: { cookie },
    });
    expect(submitted.statusCode).toBe(200);

    const dto = examDtoSchema.parse(
      (await app.inject({ method: 'GET', url: `/api/exams/${examId}`, headers: { cookie } })).json(),
    );
    expect(dto.status).toBe('submitted');
    expect(dto.answers).toMatchObject({ q1: 'SELECT 42;', q2: '5' });
  });

  it('rejects autosave past the server-authoritative deadline+grace', async () => {
    const examId = await createReadyExam();
    await app.inject({ method: 'POST', url: `/api/exams/${examId}/start`, headers: { cookie } });
    await prisma.exam.update({
      where: { id: examId },
      data: { startedAt: new Date(Date.now() - 31 * 60_000 - 30_000) },
    });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/exams/${examId}/answers`,
      payload: { answers: { q1: 'late' } },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'deadline_passed' });
  });

  it('lists only the owner’s exams, newest first, without payloads', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/exams', headers: { cookie } });
    const list = listExamsResponseSchema.parse(res.json());
    expect(list.exams.length).toBeGreaterThan(0);
    expect(res.body).not.toContain('sections');

    const foreign = listExamsResponseSchema.parse(
      (await app.inject({ method: 'GET', url: '/api/exams', headers: { cookie: otherCookie } })).json(),
    );
    expect(foreign.exams).toHaveLength(0);
  });
});
