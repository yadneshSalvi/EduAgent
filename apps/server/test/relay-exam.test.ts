import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient, Thread } from '@prisma/client';
import type { DashboardData, WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/db.js';
import { UiToolRelay } from '../src/relay/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * The Phase 4 relay activation (plans/03 §4–5): ui_create_exam resolves the
 * calling thread's single draft Exam row and fills it behind integrity +
 * targeting guardrails; ui_grade_exam validates coverage/points and persists
 * the result with the server-computed EXACT readiness snapshot. Every error
 * string is written for the agent to self-correct on.
 */

const USER_ID = 'user-rexam-1';
const TOKEN = 'tok-rexam-valid';
const TRACK = 'sql-interview';

function recordingSink() {
  const records: Array<{ target: 'thread' | 'user'; id: string; event: WsEvent }> = [];
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

/** DashboardData with one track readiness score per call (exact-snapshot math). */
function fakeDashboard(scores: number[]) {
  let call = 0;
  return {
    get(): Promise<DashboardData> {
      const score = scores[Math.min(call, scores.length - 1)] ?? 0;
      call += 1;
      return Promise.resolve({
        user: { displayName: 'X', streakDays: 0 },
        readiness: [{ track: TRACK, displayName: 'SQL', score, delta7d: 0, weakest: [] }],
        topics: [],
        decaySeries: [],
        timeline: [],
        reviewQueue: { dueToday: 0, overdue: 0, nextConcepts: [] },
        activity: [],
      });
    },
  };
}

let prisma: PrismaClient;
let workspaces: WorkspaceManager;
let cleanup: () => Promise<void>;
let sink: ReturnType<typeof recordingSink>;
let relay: UiToolRelay;
let thread: Thread;
let examId: string;

const call = (tool: string, args: Record<string, unknown>, sessionToken = TOKEN) =>
  relay.handleToolCall({ tool, args: { session_token: sessionToken, ...args }, sessionToken });

const errorOf = (result: { body: unknown }): string =>
  (result.body as { error: string }).error;

/** Hidden tests for one exam coding question, in the gitignored workdir. */
async function writeExamTests(questionId: string): Promise<void> {
  const dir = path.join(
    workspaces.pathFor(USER_ID),
    '.exercises',
    `exam-${examId}-${questionId}`,
    'tests',
  );
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'test_q.sql'), '-- expects 5 rows\n', 'utf8');
}

const SECTIONS = [
  {
    title: 'SQL',
    questions: [
      {
        id: 'q1',
        type: 'coding',
        prompt_md: 'Join orders to customers.',
        concepts: ['inner-join'],
        starter_code: 'SELECT 1;',
        language: 'sql',
        points: 10,
      },
      {
        id: 'q2',
        type: 'mcq',
        prompt_md: 'How many rows?',
        concepts: ['sql/left-join'],
        options: ['3', '5'],
        points: 5,
      },
      { id: 'q3', type: 'short', prompt_md: 'Explain WHERE vs ON.', concepts: ['where-clause'], points: 5 },
    ],
  },
];

const CREATE_ARGS = { track: TRACK, duration_min: 30, sections: SECTIONS };

const GRADES = [
  { id: 'q1', verdict: 'correct', points_awarded: 10, feedback_md: 'Clean join.' },
  { id: 'q2', verdict: 'incorrect', points_awarded: 0, feedback_md: 'It keeps 5 rows.' },
  { id: 'q3', verdict: 'partial', points_awarded: 3, feedback_md: 'ON joins, WHERE filters.' },
];

beforeEach(async () => {
  prisma = createPrisma(createTestDbUrl('relay-exam'));
  await prisma.user.create({
    data: { id: USER_ID, handle: `rexam-${Date.now()}`, displayName: 'R', workspacePath: 'x' },
  });
  thread = await prisma.thread.create({
    data: {
      userId: USER_ID,
      codexThreadId: `cdx-rexam-${Date.now()}`,
      mode: 'exam',
      trackSlug: TRACK,
      title: 'Mock exam',
      sessionToken: TOKEN,
    },
  });
  examId = `exam-${Date.now()}`;
  await prisma.exam.create({
    data: {
      id: examId,
      userId: USER_ID,
      threadId: thread.id,
      trackSlug: TRACK,
      config: { durationMin: 30, targeting: [], readinessBefore: 50 },
      questions: {},
      status: 'draft',
    },
  });

  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);
  await workspaces.ensureWorkspace(USER_ID);
  const trackPath = path.join(workspaces.pathFor(USER_ID), 'tracks', TRACK, 'track.yaml');
  await fs.mkdir(path.dirname(trackPath), { recursive: true });
  await fs.writeFile(
    trackPath,
    [
      `track: ${TRACK}`,
      'display_name: SQL Interview Prep',
      'items:',
      '  - concept: inner-join',
      '    topic: sql',
      '    weight: 1.5',
      '  - concept: left-join',
      '    topic: sql',
      '    weight: 1.2',
      '  - concept: where-clause',
      '    topic: sql',
      '    weight: 1.0',
    ].join('\n') + '\n',
    'utf8',
  );

  sink = recordingSink();
  relay = new UiToolRelay(
    { prisma, sink, workspaces, dashboard: fakeDashboard([58.4]) },
    { port: 0 },
  );
});

afterEach(async () => {
  await relay.close();
  await prisma.$disconnect();
  await cleanup();
});

describe('ui_create_exam', () => {
  it('rejects when the thread has no draft exam', async () => {
    await prisma.exam.update({ where: { id: examId }, data: { status: 'ready' } });
    const result = await call('ui_create_exam', CREATE_ARGS);
    expect(result.status).toBe(409);
    expect(errorOf(result)).toMatch(/no draft exam/i);
  });

  it('rejects a track or duration mismatch with the requested values', async () => {
    await writeExamTests('q1');
    const wrongTrack = await call('ui_create_exam', { ...CREATE_ARGS, track: 'python-dsa' });
    expect(wrongTrack.status).toBe(400);
    expect(errorOf(wrongTrack)).toContain(TRACK);

    const wrongDuration = await call('ui_create_exam', { ...CREATE_ARGS, duration_min: 45 });
    expect(wrongDuration.status).toBe(400);
    expect(errorOf(wrongDuration)).toContain('30');
  });

  it('rejects duplicate question ids across sections', async () => {
    await writeExamTests('q1');
    const result = await call('ui_create_exam', {
      ...CREATE_ARGS,
      sections: [...SECTIONS, { title: 'Dup', questions: [SECTIONS[0]!.questions[2]!] }],
    });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toContain('q3');
  });

  it('rejects coding questions whose hidden tests are missing (integrity precondition)', async () => {
    const result = await call('ui_create_exam', CREATE_ARGS);
    expect(result.status).toBe(400);
    expect(errorOf(result)).toContain(`.exercises/exam-${examId}-q1/tests`);
    expect(errorOf(result)).toMatch(/do not commit/i);
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: examId } })).status).toBe('draft');
  });

  it('rejects concepts outside the track curriculum', async () => {
    await writeExamTests('q1');
    const sections = structuredClone(SECTIONS);
    sections[0]!.questions[2]!.concepts = ['recursion'];
    const result = await call('ui_create_exam', { ...CREATE_ARGS, sections });
    expect(result.status).toBe(400);
    expect(errorOf(result)).toContain('q3');
    expect(errorOf(result)).toContain(TRACK);
  });

  it('fills the draft exam, strips the token, and announces exam.created', async () => {
    await writeExamTests('q1');
    const result = await call('ui_create_exam', CREATE_ARGS);
    expect(result.status).toBe(200);
    expect((result.body as { message: string }).message).toMatch(/do not commit/i);

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.status).toBe('ready');
    const questions = exam.questions as { sections: unknown[]; session_token?: string };
    expect(questions.sections).toHaveLength(1);
    expect(questions.session_token).toBeUndefined();
    expect(JSON.stringify(exam.questions)).not.toContain(TOKEN);

    const created = sink.records.filter((r) => r.event.type === 'exam.created');
    expect(created.map((r) => r.target).sort()).toEqual(['thread', 'user']);
    expect(created[0]!.event).toMatchObject({ examId });
  });
});

describe('ui_grade_exam', () => {
  beforeEach(async () => {
    await writeExamTests('q1');
    await call('ui_create_exam', CREATE_ARGS);
    await prisma.exam.update({
      where: { id: examId },
      data: { status: 'submitted', submittedAt: new Date(), answers: { q1: 'SELECT 1;', q2: '3' } },
    });
    sink.records.length = 0;
  });

  const gradeArgs = (overrides: Record<string, unknown> = {}) => ({
    exam_id: examId,
    per_question: GRADES,
    total: 13,
    readiness_delta: 4,
    ...overrides,
  });

  it('rejects unknown exam ids and cross-thread grading', async () => {
    const unknown = await call('ui_grade_exam', gradeArgs({ exam_id: 'nope' }));
    expect(unknown.status).toBe(404);

    const otherThread = await prisma.thread.create({
      data: {
        userId: USER_ID,
        codexThreadId: `cdx-other-${Date.now()}`,
        mode: 'exam',
        title: 'other',
        sessionToken: 'tok-other-thread',
      },
    });
    const crossThread = await call('ui_grade_exam', gradeArgs(), otherThread.sessionToken);
    expect(crossThread.status).toBe(409);
    expect(errorOf(crossThread)).toMatch(/different thread|wrong session_token/i);
  });

  it('rejects grading before submission and double grading', async () => {
    await prisma.exam.update({ where: { id: examId }, data: { status: 'in_progress' } });
    const early = await call('ui_grade_exam', gradeArgs());
    expect(early.status).toBe(409);
    expect(errorOf(early)).toMatch(/not submitted/i);

    await prisma.exam.update({ where: { id: examId }, data: { status: 'graded' } });
    const twice = await call('ui_grade_exam', gradeArgs());
    expect(twice.status).toBe(409);
    expect(errorOf(twice)).toMatch(/already graded/i);
  });

  it('requires full question coverage with known ids and sane points', async () => {
    const unknown = await call(
      'ui_grade_exam',
      gradeArgs({ per_question: [...GRADES, { id: 'q9', verdict: 'correct', points_awarded: 1, feedback_md: 'x' }] }),
    );
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown)).toContain('q9');

    const partial = await call('ui_grade_exam', gradeArgs({ per_question: GRADES.slice(0, 2), total: 10 }));
    expect(partial.status).toBe(400);
    expect(errorOf(partial)).toContain('q3');

    const overAwarded = structuredClone(GRADES);
    overAwarded[1]!.points_awarded = 99;
    const over = await call('ui_grade_exam', gradeArgs({ per_question: overAwarded, total: 112 }));
    expect(over.status).toBe(400);
    expect(errorOf(over)).toContain('q2');

    const badTotal = await call('ui_grade_exam', gradeArgs({ total: 20 }));
    expect(badTotal.status).toBe(400);
    expect(errorOf(badTotal)).toContain('13');
  });

  it('persists the result with the EXACT readiness snapshot, records activity, and announces exam.graded', async () => {
    const result = await call('ui_grade_exam', gradeArgs({ readiness_delta: 99 }));
    expect(result.status).toBe(200);
    // Instructive result carries the exact numbers for the exam record.
    const message = (result.body as { message: string }).message;
    expect(message).toContain('50.0 → 58.4');
    expect(message).toContain('+8.4');

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.status).toBe('graded');
    expect(exam.gradedAt).not.toBeNull();
    // Agent's estimate (99) is overridden by the computed exact delta.
    expect(exam.result).toMatchObject({
      total: 13,
      readiness_delta: 8.4,
      readiness_before: 50,
      readiness_after: 58.4,
    });
    expect(JSON.stringify(exam.result)).not.toContain(TOKEN);

    const activity = await prisma.activityEvent.findMany({ where: { userId: USER_ID } });
    expect(activity.some((a) => a.kind === 'exam_graded')).toBe(true);

    const graded = sink.records.filter((r) => r.event.type === 'exam.graded');
    expect(graded.map((r) => r.target).sort()).toEqual(['thread', 'user']);
  });

  it('keeps the persisted delta consistent with the ROUNDED before/after (E2E run-4 rounding split)', async () => {
    // readinessBefore 50.25 rounds to 50.3; the raw delta 58.4 − 50.25 = 8.15
    // rounds to 8.2 — but the stored trio must satisfy delta = after − before
    // on the ROUNDED values (8.1), because the record and the web recompute
    // it from what was persisted.
    await prisma.exam.update({
      where: { id: examId },
      data: { config: { durationMin: 30, targeting: [], readinessBefore: 50.25 } },
    });
    const result = await call('ui_grade_exam', gradeArgs());
    expect(result.status).toBe(200);
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    const stored = exam.result as {
      readiness_before: number;
      readiness_after: number;
      readiness_delta: number;
    };
    expect(stored.readiness_before).toBe(50.3);
    expect(stored.readiness_after).toBe(58.4);
    expect(stored.readiness_delta).toBe(
      Math.round((stored.readiness_after - stored.readiness_before) * 10) / 10,
    );
    expect(stored.readiness_delta).toBe(8.1);
  });
});
