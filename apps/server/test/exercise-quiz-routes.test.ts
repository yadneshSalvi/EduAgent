import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient, Thread } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { exerciseDtoSchema, type WsEvent } from '@eduagent/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsGateway } from '../src/api/gateway.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import type { EnsureThreadResult, ThreadService } from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * Exercise + quiz pipeline routes (plans/03 §3.5, §7): submissions persist
 * Attempts, land the code in the workspace, and start a SYSTEM grading turn
 * on the exercise/quiz's own thread. The ThreadService is faked — grading
 * behavior itself is the E2E's job.
 */

class RecordingThreadService implements ThreadService {
  systemTurns: Array<{ threadId: string; text: string }> = [];
  failNext = false;
  /**
   * Like the real ThreadManager, startSystemTurn resolves only when the turn
   * SETTLES — turns stay pending until a test calls settleSystemTurns(),
   * which is what triggers the routes' post-settle reconciliation.
   */
  private settlers: Array<() => void> = [];

  settleSystemTurns(): void {
    for (const settle of this.settlers.splice(0)) settle();
  }

  ensureThread(): Promise<EnsureThreadResult> {
    return Promise.reject(new Error('not used'));
  }
  startTurn(): Promise<void> {
    return Promise.resolve();
  }
  startSystemTurn(thread: Thread, text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('backend down'));
    }
    this.systemTurns.push({ threadId: thread.id, text });
    return new Promise<void>((resolve) => {
      this.settlers.push(resolve);
    });
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

/** Captures WS emissions so tests can assert on reconciliation turn.errors. */
class RecordingGateway {
  threadEvents: Array<{ threadId: string; event: WsEvent }> = [];
  emitToThread(threadId: string, event: WsEvent): void {
    this.threadEvents.push({ threadId, event });
  }
  emitToUser(): void {}

  turnErrors(threadId: string): string[] {
    return this.threadEvents
      .filter((e) => e.threadId === threadId && e.event.type === 'turn.error')
      .map((e) => (e.event as { message: string }).message);
  }
}

let app: FastifyInstance;
let prisma: PrismaClient;
let threads: RecordingThreadService;
let gateway: RecordingGateway;
let workspaces: WorkspaceManager;
let cleanup: () => Promise<void>;
let cookie: string;
let userId: string;
let thread: Thread;

async function seedExercise(slug: string, ownerId = userId, threadId?: string) {
  return prisma.exercise.create({
    data: {
      slug,
      userId: ownerId,
      threadId: threadId ?? thread.id,
      language: 'python',
      title: 'Filter the orders',
      prompt: 'Only paid orders.',
      starterCode: 'def filter_orders(orders): ...',
      concepts: ['list-comprehension'] as Prisma.InputJsonValue,
      difficulty: 'easy',
    },
  });
}

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('exercise-quiz-routes');
  prisma = createPrisma(databaseUrl);
  threads = new RecordingThreadService();
  gateway = new RecordingGateway();
  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: databaseUrl,
      DATA_DIR: dataDir.config.dataDir,
      SESSION_SECRET: 'exercise-routes-test-secret',
    }),
    prisma,
    services: { threads, workspaces, gateway: gateway as unknown as WsGateway },
  });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: '/auth/local-login',
    payload: { handle: 'exercise-user' },
  });
  expect(res.statusCode).toBe(200);
  cookie = String(res.headers['set-cookie']).split(';')[0]!;
  userId = (res.json() as { id: string }).id;
  await workspaces.ensureWorkspace(userId);
  thread = await prisma.thread.create({
    data: {
      userId,
      codexThreadId: `cdx-exq-${Date.now()}`,
      mode: 'learn',
      title: 'test',
      sessionToken: `tok-exq-${Date.now()}`,
    },
  });
});

beforeEach(() => {
  threads.systemTurns = [];
  gateway.threadEvents = [];
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await cleanup();
});

describe('GET /api/exercises/:id', () => {
  it('returns the DTO (id = slug) with attempts', async () => {
    const exercise = await seedExercise('ex-100');
    await prisma.exerciseAttempt.create({
      data: { exerciseId: exercise.id, code: 'attempt 1', verdict: 'failed', feedback: 'nope' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/exercises/ex-100',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const dto = exerciseDtoSchema.parse(res.json());
    expect(dto.id).toBe('ex-100');
    expect(dto.attempts).toHaveLength(1);
    expect(dto.attempts![0]).toMatchObject({ verdict: 'failed', feedback: 'nope' });
  });

  it("404s another user's exercise", async () => {
    const other = await prisma.user.create({
      data: { handle: `other-${Date.now()}`, displayName: 'O', workspacePath: 'x' },
    });
    await seedExercise('ex-101', other.id);
    const res = await app.inject({
      method: 'GET',
      url: '/api/exercises/ex-101',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
  });

  it('401s without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/exercises/ex-100' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /api/exercises/:id/submit', () => {
  it('persists the attempt, writes the submission file, and starts a system grading turn', async () => {
    await seedExercise('ex-200');
    const code = 'def filter_orders(orders):\n    return [o for o in orders if o.paid]\n';
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-200/submit',
      headers: { cookie },
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: true; attemptId: string };
    expect(body.ok).toBe(true);

    const attempt = await prisma.exerciseAttempt.findUnique({ where: { id: body.attemptId } });
    expect(attempt).toMatchObject({ code, verdict: null });

    const submission = await fs.readFile(
      path.join(workspaces.pathFor(userId), '.exercises', 'ex-200', 'submission.py'),
      'utf8',
    );
    expect(submission).toBe(code);

    expect(threads.systemTurns).toHaveLength(1);
    const turn = threads.systemTurns[0]!;
    expect(turn.threadId).toBe(thread.id);
    expect(turn.text).toContain('exercise ex-200');
    expect(turn.text).toContain('.exercises/ex-200/tests/');
    expect(turn.text).toContain('ui_grade_exercise');
    expect(turn.text).toMatch(/never infer a verdict/i);
    expect(turn.text).toContain(code.trim());
  });

  it('409s while a previous attempt is still ungraded', async () => {
    await seedExercise('ex-201');
    const first = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-201/submit',
      headers: { cookie },
      payload: { code: 'attempt one' },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-201/submit',
      headers: { cookie },
      payload: { code: 'attempt two' },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: string }).error).toBe('grading_in_progress');
    expect(threads.systemTurns).toHaveLength(1);
  });

  it('accepts a resubmit after the previous attempt was graded', async () => {
    const exercise = await seedExercise('ex-202');
    await prisma.exerciseAttempt.create({
      data: { exerciseId: exercise.id, code: 'old', verdict: 'failed', gradedAt: new Date() },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-202/submit',
      headers: { cookie },
      payload: { code: 'new try' },
    });
    expect(res.statusCode).toBe(200);
    expect(threads.systemTurns[0]!.text).toContain('attempt 2');
  });

  it('400s an empty body', async () => {
    await seedExercise('ex-203');
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-203/submit',
      headers: { cookie },
      payload: { code: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('grading-turn settle reconciliation', () => {
  /** Fresh thread per test so stale settles elsewhere never pollute assertions. */
  async function freshThread() {
    return prisma.thread.create({
      data: {
        userId,
        codexThreadId: `cdx-recon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        mode: 'learn',
        title: 'reconciliation',
        sessionToken: `tok-recon-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      },
    });
  }

  it('a settled turn with no verdict marks the attempt `error` and unblocks resubmits', async () => {
    const own = await freshThread();
    await seedExercise('ex-210', userId, own.id);
    const first = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-210/submit',
      headers: { cookie },
      payload: { code: 'attempt one' },
    });
    expect(first.statusCode).toBe(200);
    const { attemptId } = first.json() as { attemptId: string };

    threads.settleSystemTurns();
    await vi.waitFor(async () => {
      const attempt = await prisma.exerciseAttempt.findUnique({ where: { id: attemptId } });
      expect(attempt?.verdict).toBe('error');
      expect(attempt?.gradedAt).not.toBeNull();
    });
    expect(gateway.turnErrors(own.id)).toContainEqual(
      expect.stringContaining('without delivering a verdict'),
    );

    // The 409 deadlock is gone: the learner can submit again.
    const second = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-210/submit',
      headers: { cookie },
      payload: { code: 'attempt two' },
    });
    expect(second.statusCode).toBe(200);
  });

  it('an attempt the agent graded during the turn is left untouched (no turn.error)', async () => {
    const own = await freshThread();
    await seedExercise('ex-211', userId, own.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-211/submit',
      headers: { cookie },
      payload: { code: 'attempt one' },
    });
    const { attemptId } = res.json() as { attemptId: string };
    // The relay graded mid-turn (ui_grade_exercise).
    await prisma.exerciseAttempt.update({
      where: { id: attemptId },
      data: { verdict: 'passed', feedback: 'clean', gradedAt: new Date() },
    });

    threads.settleSystemTurns();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const attempt = await prisma.exerciseAttempt.findUnique({ where: { id: attemptId } });
    expect(attempt?.verdict).toBe('passed');
    expect(gateway.turnErrors(own.id)).toHaveLength(0);
  });

  it('a start failure marks the attempt `error` too (never a permanent 409)', async () => {
    const own = await freshThread();
    await seedExercise('ex-212', userId, own.id);
    threads.failNext = true;
    const res = await app.inject({
      method: 'POST',
      url: '/api/exercises/ex-212/submit',
      headers: { cookie },
      payload: { code: 'attempt one' },
    });
    expect(res.statusCode).toBe(200);
    const { attemptId } = res.json() as { attemptId: string };
    await vi.waitFor(async () => {
      const attempt = await prisma.exerciseAttempt.findUnique({ where: { id: attemptId } });
      expect(attempt?.verdict).toBe('error');
    });
    expect(gateway.turnErrors(own.id)).toContainEqual(
      expect.stringContaining('Grading could not start'),
    );
  });

  it('a settled quiz turn with no quiz_graded activity emits turn.error', async () => {
    const own = await freshThread();
    await prisma.itemMirror.create({
      data: {
        threadId: own.id,
        role: 'agent',
        kind: 'quiz',
        payload: {
          id: 'quiz-210',
          concepts: ['inner-join'],
          questions: [{ id: 'q-1', type: 'short', prompt_md: 'Explain WHERE vs ON.' }],
        } as Prisma.InputJsonValue,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/quiz/quiz-210/submit',
      headers: { cookie },
      payload: { answers: [{ question_id: 'q-1', answer: 'WHERE filters after the join.' }] },
    });
    expect(res.statusCode).toBe(200);

    threads.settleSystemTurns();
    await vi.waitFor(() => {
      expect(gateway.turnErrors(own.id)).toContainEqual(
        expect.stringContaining('without grading this quiz'),
      );
    });
  });

  it('a quiz the agent graded during the turn stays quiet', async () => {
    const own = await freshThread();
    await prisma.itemMirror.create({
      data: {
        threadId: own.id,
        role: 'agent',
        kind: 'quiz',
        payload: {
          id: 'quiz-211',
          concepts: ['inner-join'],
          questions: [{ id: 'q-1', type: 'short', prompt_md: 'Explain WHERE vs ON.' }],
        } as Prisma.InputJsonValue,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/quiz/quiz-211/submit',
      headers: { cookie },
      payload: { answers: [{ question_id: 'q-1', answer: 'WHERE filters after the join.' }] },
    });
    expect(res.statusCode).toBe(200);
    // The relay recorded the grade mid-turn (ui_grade_quiz).
    await prisma.activityEvent.create({
      data: {
        userId,
        kind: 'quiz_graded',
        meta: { threadId: own.id, quizId: 'quiz-211', results: [] } as Prisma.InputJsonValue,
      },
    });

    threads.settleSystemTurns();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(gateway.turnErrors(own.id)).toHaveLength(0);
  });
});

describe('POST /api/quiz/:id/submit', () => {
  async function seedQuiz(quizId: string) {
    await prisma.itemMirror.create({
      data: {
        threadId: thread.id,
        role: 'agent',
        kind: 'quiz',
        payload: {
          id: quizId,
          concepts: ['inner-join'],
          questions: [
            { id: 'q-1', type: 'mcq', prompt_md: 'Rows?', options: ['3', '5'], answer: '5' },
            { id: 'q-2', type: 'short', prompt_md: 'Explain WHERE vs ON.' },
          ],
        } as Prisma.InputJsonValue,
      },
    });
  }

  it('starts a system grading turn carrying answers + instant verdicts', async () => {
    await seedQuiz('quiz-200');
    const res = await app.inject({
      method: 'POST',
      url: '/api/quiz/quiz-200/submit',
      headers: { cookie },
      payload: {
        answers: [
          { question_id: 'q-1', answer: '5', verdict: 'correct' },
          { question_id: 'q-2', answer: 'WHERE filters rows after the join.' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    expect(threads.systemTurns).toHaveLength(1);
    const text = threads.systemTurns[0]!.text;
    expect(text).toContain('quiz quiz-200');
    expect(text).toContain('instant-checked: correct');
    expect(text).toContain('WHERE filters rows after the join.');
    expect(text).toContain('ui_grade_quiz');
    expect(text).toContain('q-2');
  });

  it('404s an unknown quiz and 400s unknown question ids', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/quiz/quiz-404/submit',
      headers: { cookie },
      payload: { answers: [{ question_id: 'q-1', answer: 'x' }] },
    });
    expect(missing.statusCode).toBe(404);

    await seedQuiz('quiz-201');
    const bad = await app.inject({
      method: 'POST',
      url: '/api/quiz/quiz-201/submit',
      headers: { cookie },
      payload: { answers: [{ question_id: 'q-99', answer: 'x' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { message: string }).message).toContain('q-99');
  });

  it("cannot submit another user's quiz", async () => {
    const other = await prisma.user.create({
      data: { handle: `other-q-${Date.now()}`, displayName: 'O', workspacePath: 'x' },
    });
    const otherThread = await prisma.thread.create({
      data: {
        userId: other.id,
        codexThreadId: `cdx-other-${Date.now()}`,
        mode: 'learn',
        title: 'other',
        sessionToken: `tok-other-${Date.now()}`,
      },
    });
    await prisma.itemMirror.create({
      data: {
        threadId: otherThread.id,
        role: 'agent',
        kind: 'quiz',
        payload: {
          id: 'quiz-foreign',
          concepts: ['inner-join'],
          questions: [{ id: 'q-1', type: 'short', prompt_md: 'Explain.' }],
        } as Prisma.InputJsonValue,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/quiz/quiz-foreign/submit',
      headers: { cookie },
      payload: { answers: [{ question_id: 'q-1', answer: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
  });
});
