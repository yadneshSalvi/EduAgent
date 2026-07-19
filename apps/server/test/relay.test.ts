import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient, Thread } from '@prisma/client';
import type { WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/db.js';
import { findQuizForUser, UiToolRelay } from '../src/relay/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * UiToolRelay against a real test db + temp workspace + recording sink
 * (plans/03 §4): token auth, per-tool dispatch/persistence/WS pushes, and —
 * because the agent reads these — the INSTRUCTIVE error strings.
 */

interface SinkRecord {
  target: 'thread' | 'user';
  id: string;
  event: WsEvent;
}

function recordingSink() {
  const records: SinkRecord[] = [];
  return {
    records,
    emitToThread(id: string, event: WsEvent) {
      records.push({ target: 'thread', id, event });
    },
    emitToUser(id: string, event: WsEvent) {
      records.push({ target: 'user', id, event });
    },
  };
}

const USER_ID = 'user-relay-1';
const TOKEN = 'tok-relay-valid';

let prisma: PrismaClient;
let workspaces: WorkspaceManager;
let cleanup: () => Promise<void>;
let sink: ReturnType<typeof recordingSink>;
let relay: UiToolRelay;
let thread: Thread;

function call(tool: string, args: Record<string, unknown>, sessionToken = TOKEN) {
  return relay.handleToolCall({ tool, args: { session_token: sessionToken, ...args }, sessionToken });
}

/** Writes a hidden-tests dir for `exerciseId` into the user's workspace. */
async function writeTests(exerciseId: string): Promise<string> {
  const dir = path.join(workspaces.pathFor(USER_ID), '.exercises', exerciseId, 'tests');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'test_solution.py'), 'def test(): pass\n', 'utf8');
  return `.exercises/${exerciseId}/tests/`;
}

const EXERCISE_ARGS = {
  id: 'ex-001',
  title: 'Filter the orders',
  language: 'python',
  prompt_md: 'Write `filter_orders` returning only paid orders.',
  starter_code: 'def filter_orders(orders):\n    ...\n',
  concepts: ['list-comprehension'],
  difficulty: 'easy',
  tests_path: '.exercises/ex-001/tests/',
};

const QUIZ_ARGS = {
  id: 'quiz-001',
  concepts: ['inner-join'],
  questions: [
    {
      id: 'q-1',
      type: 'mcq',
      prompt_md: 'How many rows?',
      options: ['3', '5'],
      answer: '5',
    },
    { id: 'q-2', type: 'short', prompt_md: 'Explain WHERE vs ON.' },
  ],
};

beforeEach(async () => {
  prisma = createPrisma(createTestDbUrl('relay'));
  await prisma.user.create({
    data: { id: USER_ID, handle: `relay-${Date.now()}`, displayName: 'R', workspacePath: 'x' },
  });
  thread = await prisma.thread.create({
    data: {
      userId: USER_ID,
      codexThreadId: `cdx-relay-${Date.now()}`,
      mode: 'learn',
      title: 'test',
      sessionToken: TOKEN,
    },
  });

  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);
  await workspaces.ensureWorkspace(USER_ID);

  sink = recordingSink();
  relay = new UiToolRelay({ prisma, sink, workspaces }, { port: 0 });
});

afterEach(async () => {
  await relay.close();
  await prisma.$disconnect();
  await cleanup();
});

describe('auth', () => {
  it('rejects an unknown token with a self-correction hint', async () => {
    const result = await call('ui_push_artifact', { id: 'a', title: 'T', html: '<b>x</b>' }, 'nope');
    expect(result.status).toBe(401);
    expect(result.body).toMatchObject({ ok: false });
    expect((result.body as { error: string }).error).toMatch(/re-read the session_token/i);
    expect(sink.records).toEqual([]);
  });

  it('rejects an empty token without leaking anything', async () => {
    const result = await call('ui_push_artifact', { id: 'a', title: 'T', html: '<b>x</b>' }, '');
    expect(result.status).toBe(401);
  });

  it("rejects an archived thread's token (no replay after archive)", async () => {
    await prisma.thread.update({ where: { id: thread.id }, data: { status: 'archived' } });
    const result = await call('ui_push_artifact', { id: 'a', title: 'T', html: '<b>x</b>' });
    expect(result.status).toBe(401);
    expect(sink.records).toEqual([]);
  });

  it('rejects unknown tools by name', async () => {
    const result = await relay.handleToolCall({ tool: 'ui_hack', args: {}, sessionToken: TOKEN });
    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toContain('ui_push_exercise');
  });

  it('rejects malformed bodies', async () => {
    const result = await relay.handleToolCall({ nope: true });
    expect(result.status).toBe(400);
  });
});

describe('ui_session_wrap', () => {
  const args = {
    day: 3,
    summary_md: 'Practised JOIN result shapes.\nNULL handling still needs one more pass.',
    concept_deltas: [{ topic: 'sql', concept: 'inner-join', from: 0.4, to: 0.6 }],
  };

  it('rejects non-track threads with self-correcting guidance', async () => {
    const result = await call('ui_session_wrap', args);
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/only for a learning-track session/i);
  });

  it('mirrors a wrap and emits session.wrap only for the matching roadmap day', async () => {
    await prisma.thread.update({
      where: { id: thread.id },
      data: { trackSlug: 'sql-interview', roadmapDay: 3, intent: 'teach' },
    });
    const wrong = await call('ui_session_wrap', { ...args, day: 4 });
    expect(wrong.status).toBe(400);
    const result = await call('ui_session_wrap', args);
    expect(result.status).toBe(200);
    const mirror = await prisma.itemMirror.findFirstOrThrow({ where: { threadId: thread.id } });
    expect(mirror).toMatchObject({ role: 'agent', kind: 'wrap' });
    expect(mirror.payload).toMatchObject({ day: 3, summary_md: args.summary_md });
    expect(sink.records).toContainEqual({
      target: 'thread',
      id: thread.id,
      event: { type: 'session.wrap', threadId: thread.id, wrap: args },
    });
  });
});

describe('ui_push_exercise', () => {
  it('persists the Exercise row, mirrors it, and emits workbench.exercise WITHOUT token/tests_path', async () => {
    await writeTests('ex-001');
    const result = await call('ui_push_exercise', EXERCISE_ARGS);
    expect(result.status).toBe(200);
    expect((result.body as { message: string }).message).toMatch(/do not reveal/i);

    const row = await prisma.exercise.findUnique({
      where: { userId_slug: { userId: USER_ID, slug: 'ex-001' } },
    });
    expect(row).toMatchObject({
      slug: 'ex-001',
      threadId: thread.id,
      language: 'python',
      status: 'open',
    });

    const emitted = sink.records.find((r) => r.event.type === 'workbench.exercise');
    expect(emitted).toMatchObject({ target: 'thread', id: thread.id });
    const exercise = (emitted!.event as Extract<WsEvent, { type: 'workbench.exercise' }>).exercise;
    expect(exercise.id).toBe('ex-001');
    expect(exercise).not.toHaveProperty('session_token');
    expect(exercise).not.toHaveProperty('tests_path');

    const mirror = await prisma.itemMirror.findMany({ where: { threadId: thread.id } });
    expect(mirror).toHaveLength(1);
    expect(mirror[0]).toMatchObject({ role: 'agent', kind: 'exercise_ref' });
    expect(mirror[0]!.payload).not.toHaveProperty('tests_path');
  });

  it('refuses to push when the hidden tests are missing (teach-skill guardrail)', async () => {
    const result = await call('ui_push_exercise', EXERCISE_ARGS);
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/fail on the starter/i);
    expect(await prisma.exercise.count()).toBe(0);
    expect(sink.records).toEqual([]);
  });

  it('refuses tests_path outside .exercises/<id>/', async () => {
    await writeTests('ex-001');
    const result = await call('ui_push_exercise', {
      ...EXERCISE_ARGS,
      tests_path: '../outside/tests/',
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('.exercises/ex-001/');
  });

  it('replaces a still-open exercise (idempotent retry) but refuses a graded slug', async () => {
    await writeTests('ex-001');
    expect((await call('ui_push_exercise', EXERCISE_ARGS)).status).toBe(200);
    expect(
      (await call('ui_push_exercise', { ...EXERCISE_ARGS, title: 'Retry title' })).status,
    ).toBe(200);
    expect(await prisma.exercise.count()).toBe(1);
    const row = await prisma.exercise.findUnique({
      where: { userId_slug: { userId: USER_ID, slug: 'ex-001' } },
    });
    expect(row!.title).toBe('Retry title');

    await prisma.exercise.update({ where: { id: row!.id }, data: { status: 'passed' } });
    const refused = await call('ui_push_exercise', EXERCISE_ARGS);
    expect(refused.status).toBe(409);
    expect((refused.body as { error: string }).error).toMatch(/next unused id/i);
  });

  it('returns instructive zod errors for malformed args', async () => {
    const result = await call('ui_push_exercise', { id: 'ex-002' });
    expect(result.status).toBe(400);
    const error = (result.body as { error: string }).error;
    expect(error).toContain('ui_push_exercise');
    expect(error).toMatch(/title/);
    expect(error).toMatch(/call the tool again/i);
  });
});

describe('ui_push_quiz', () => {
  it('mirrors the payload (kind quiz, answers INCLUDED) and emits workbench.quiz', async () => {
    const result = await call('ui_push_quiz', QUIZ_ARGS);
    expect(result.status).toBe(200);
    expect((result.body as { message: string }).message).toMatch(/short answer/);

    const mirror = await prisma.itemMirror.findMany({ where: { kind: 'quiz' } });
    expect(mirror).toHaveLength(1);
    // Accepted team decision (plans/03 §5): answers ship to the client for
    // learn/review quizzes. Do not "fix" this.
    expect(mirror[0]!.payload).toMatchObject({
      id: 'quiz-001',
      questions: [{ id: 'q-1', answer: '5' }, { id: 'q-2' }],
    });
    expect(mirror[0]!.payload).not.toHaveProperty('session_token');

    const emitted = sink.records.find((r) => r.event.type === 'workbench.quiz');
    expect(emitted).toMatchObject({ target: 'thread', id: thread.id });
    const quiz = (emitted!.event as Extract<WsEvent, { type: 'workbench.quiz' }>).quiz;
    expect(quiz.questions[0]).toMatchObject({ answer: '5' });

    // The mirrored row is how POST /api/quiz/:id/submit resolves the quiz.
    const found = await findQuizForUser(prisma, USER_ID, 'quiz-001');
    expect(found).toMatchObject({ threadId: thread.id });
  });

  it('requires answers on mcq/predict_output questions', async () => {
    const result = await call('ui_push_quiz', {
      ...QUIZ_ARGS,
      questions: [{ id: 'q-1', type: 'mcq', prompt_md: 'Rows?', options: ['3', '5'] }],
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/include the correct answer/i);
  });

  it('requires the mcq answer to be one of the options', async () => {
    const result = await call('ui_push_quiz', {
      ...QUIZ_ARGS,
      questions: [
        { id: 'q-1', type: 'mcq', prompt_md: 'Rows?', options: ['3', '5'], answer: 'five' },
      ],
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/exactly match one option/i);
  });
});

describe('ui_push_artifact', () => {
  it('emits workbench.artifact (no persistence)', async () => {
    const result = await call('ui_push_artifact', {
      id: 'art-1',
      title: 'Join diagram',
      html: '<svg></svg>',
    });
    expect(result.status).toBe(200);
    const emitted = sink.records.find((r) => r.event.type === 'workbench.artifact');
    expect(emitted).toMatchObject({ target: 'thread', id: thread.id });
    expect(await prisma.itemMirror.count()).toBe(0);
  });
});

describe('ui_record_assessment', () => {
  it('writes an ActivityEvent and emits assessment.recorded to thread AND user', async () => {
    const result = await call('ui_record_assessment', {
      concept_deltas: [
        { topic: 'sql', concept: 'inner-join', from: 0.4, to: 0.6, evidence: 'ex-001 passed' },
      ],
      misconceptions_resolved: ['WHERE filters before JOIN'],
    });
    expect(result.status).toBe(200);
    expect((result.body as { message: string }).message).toMatch(/exact numbers/i);

    const events = await prisma.activityEvent.findMany({ where: { userId: USER_ID } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'assessment' });

    const targets = sink.records
      .filter((r) => r.event.type === 'assessment.recorded')
      .map((r) => r.target)
      .sort();
    expect(targets).toEqual(['thread', 'user']);
    const event = sink.records.find((r) => r.event.type === 'assessment.recorded')!
      .event as Extract<WsEvent, { type: 'assessment.recorded' }>;
    expect(event.concept_deltas[0]).toMatchObject({ concept: 'inner-join', from: 0.4, to: 0.6 });
  });

  it('rejects out-of-range mastery scores', async () => {
    const result = await call('ui_record_assessment', {
      concept_deltas: [{ topic: 'sql', concept: 'x', from: 0.2, to: 1.4, evidence: 'e' }],
    });
    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('concept_deltas');
  });
});

describe('ui_grade_exercise', () => {
  async function pushAndAttempt(): Promise<string> {
    await writeTests('ex-001');
    await call('ui_push_exercise', EXERCISE_ARGS);
    const exercise = await prisma.exercise.findUnique({
      where: { userId_slug: { userId: USER_ID, slug: 'ex-001' } },
    });
    const attempt = await prisma.exerciseAttempt.create({
      data: { exerciseId: exercise!.id, code: 'def filter_orders(o): return o' },
    });
    return attempt.id;
  }

  it('updates Exercise + Attempt and emits exercise.graded', async () => {
    const attemptId = await pushAndAttempt();
    const result = await call('ui_grade_exercise', {
      exercise_id: 'ex-001',
      verdict: 'failed',
      feedback_md: 'The happy path passes but paid=None slips through.',
    });
    expect(result.status).toBe(200);
    expect((result.body as { message: string }).message).toMatch(/never the full solution/i);

    const exercise = await prisma.exercise.findUnique({
      where: { userId_slug: { userId: USER_ID, slug: 'ex-001' } },
    });
    expect(exercise!.status).toBe('failed');
    const attempt = await prisma.exerciseAttempt.findUnique({ where: { id: attemptId } });
    expect(attempt).toMatchObject({ verdict: 'failed' });
    expect(attempt!.gradedAt).not.toBeNull();

    const graded = sink.records.filter((r) => r.event.type === 'exercise.graded');
    expect(graded.map((r) => r.target).sort()).toEqual(['thread', 'user']);
    expect(graded[0]!.event).toMatchObject({ exerciseId: 'ex-001', verdict: 'failed' });

    const activity = await prisma.activityEvent.findMany({ where: { userId: USER_ID } });
    expect(activity.map((a) => a.kind)).toContain('exercise_fail');
  });

  it('refuses to grade an unknown exercise, instructively', async () => {
    const result = await call('ui_grade_exercise', {
      exercise_id: 'ex-999',
      verdict: 'passed',
      feedback_md: 'nice',
    });
    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch(/exact id you pushed/i);
  });

  it('refuses to grade before any submission exists', async () => {
    await writeTests('ex-001');
    await call('ui_push_exercise', EXERCISE_ARGS);
    const result = await call('ui_grade_exercise', {
      exercise_id: 'ex-001',
      verdict: 'passed',
      feedback_md: 'looks great',
    });
    expect(result.status).toBe(409);
    expect((result.body as { error: string }).error).toMatch(/wait for the learner/i);
  });
});

describe('ui_grade_quiz', () => {
  it('emits quiz.graded and records activity', async () => {
    await call('ui_push_quiz', QUIZ_ARGS);
    const result = await call('ui_grade_quiz', {
      quiz_id: 'quiz-001',
      results: [
        { question_id: 'q-2', verdict: 'partial', feedback_md: 'ON joins, WHERE filters — half right.' },
      ],
    });
    expect(result.status).toBe(200);

    const graded = sink.records.filter((r) => r.event.type === 'quiz.graded');
    expect(graded.map((r) => r.target).sort()).toEqual(['thread', 'user']);
    expect(graded[0]!.event).toMatchObject({ quizId: 'quiz-001' });
    const activity = await prisma.activityEvent.findMany({ where: { userId: USER_ID } });
    expect(activity.map((a) => a.kind)).toContain('quiz_graded');
  });

  it('rejects unknown quiz ids and unknown question ids, instructively', async () => {
    const missing = await call('ui_grade_quiz', {
      quiz_id: 'quiz-404',
      results: [{ question_id: 'q-1', verdict: 'correct', feedback_md: 'ok' }],
    });
    expect(missing.status).toBe(404);
    expect((missing.body as { error: string }).error).toMatch(/exact quiz id/i);

    await call('ui_push_quiz', QUIZ_ARGS);
    const badQuestion = await call('ui_grade_quiz', {
      quiz_id: 'quiz-001',
      results: [{ question_id: 'q-99', verdict: 'correct', feedback_md: 'ok' }],
    });
    expect(badQuestion.status).toBe(400);
    expect((badQuestion.body as { error: string }).error).toContain('q-1, q-2');
  });
});

describe('exam tools (active since Phase 4 — full coverage in relay-exam.test.ts)', () => {
  it('rejects exam tool calls from a non-exam context with instructive errors', async () => {
    // This learn thread owns no draft Exam row, so ui_create_exam refuses.
    const create = await call('ui_create_exam', {
      track: 'sql-interview',
      duration_min: 30,
      sections: [
        {
          title: 'Joins',
          questions: [
            { id: 'q1', type: 'short', prompt_md: 'Explain.', concepts: ['inner-join'], points: 5 },
          ],
        },
      ],
    });
    expect(create.status).toBe(409);
    expect((create.body as { error: string }).error).toMatch(/no draft exam/i);
    expect((create.body as { error: string }).error).toMatch(/do not retry/i);

    const grade = await call('ui_grade_exam', {
      exam_id: 'x',
      per_question: [{ id: 'q1', verdict: 'correct', points_awarded: 5, feedback_md: 'ok' }],
      total: 5,
      readiness_delta: 0.1,
    });
    expect(grade.status).toBe(404);
    expect((grade.body as { error: string }).error).toMatch(/exact exam id/i);
  });
});

describe('HTTP shell', () => {
  it('serves POST /tool-call on 127.0.0.1 and rejects other routes', async () => {
    const port = await relay.listen();
    const good = await fetch(`http://127.0.0.1:${port}/tool-call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'ui_push_artifact',
        args: { session_token: TOKEN, id: 'a1', title: 'T', html: '<p>hi</p>' },
        sessionToken: TOKEN,
      }),
    });
    expect(good.status).toBe(200);
    expect(await good.json()).toMatchObject({ ok: true });

    const wrongRoute = await fetch(`http://127.0.0.1:${port}/other`, { method: 'POST' });
    expect(wrongRoute.status).toBe(404);

    const badJson = await fetch(`http://127.0.0.1:${port}/tool-call`, {
      method: 'POST',
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
  });
});
