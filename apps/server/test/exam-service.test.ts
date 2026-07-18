import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient, Thread } from '@prisma/client';
import type { DashboardData, ThreadMode, WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrisma } from '../src/db.js';
import {
  DeadlinePassedError,
  EXAM_GRACE_MS,
  EXAM_IGNORE_PATTERN,
  ExamForkError,
  ExamService,
  ExamStateError,
  examDeadline,
  examExpired,
  parseExamConfig,
  UnknownTrackError,
} from '../src/learning/index.js';
import type { EnsureThreadResult, ExamForkOptions, ExamThreadService } from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * ExamService state machine + deadline math + sweep against a real test db
 * and a fake ExamThreadService (plans/03 §3.5). The relay transitions
 * (draft→ready, submitted→graded) are covered in relay-exam.test.ts; here
 * they're simulated with direct row updates.
 */

const USER_ID = 'user-exam-1';
const TRACK = 'sql-interview';

const QUESTIONS = {
  track: TRACK,
  duration_min: 30,
  sections: [
    {
      title: 'Coding',
      questions: [
        {
          id: 'q1',
          type: 'coding' as const,
          prompt_md: 'Write the join.',
          concepts: ['inner-join'],
          starter_code: 'SELECT 1;',
          language: 'sql',
          points: 10,
        },
        {
          id: 'q2',
          type: 'mcq' as const,
          prompt_md: 'How many rows?',
          concepts: ['left-join'],
          options: ['3', '5'],
          points: 5,
        },
      ],
    },
  ],
};

interface TurnRecord {
  threadId: string;
  text: string;
  caption: string | undefined;
}

class FakeThreadService implements ExamThreadService {
  readonly systemTurns: TurnRecord[] = [];
  readonly forks: ExamForkOptions[] = [];
  readonly invalidated: string[] = [];
  inFlight = false;
  /** Resolves startSystemTurn; tests can override to keep turns pending. */
  turnGate: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaClient) {}

  async ensureThread(userId: string, mode: ThreadMode): Promise<EnsureThreadResult> {
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: `cdx-ensure-${Date.now()}-${Math.random()}`,
        mode,
        title: 'ensured',
        sessionToken: `tok-ensure-${Date.now()}-${Math.random()}`,
      },
    });
    return { thread, created: true };
  }

  async forkForExam(parent: Thread, opts: ExamForkOptions): Promise<Thread> {
    this.forks.push(opts);
    return this.prisma.thread.create({
      data: {
        userId: parent.userId,
        codexThreadId: `cdx-fork-${this.forks.length}`,
        mode: 'exam',
        trackSlug: opts.trackSlug,
        title: `Mock exam — ${opts.trackSlug}`,
        forkedFromId: parent.id,
        sessionToken: `tok-fork-${this.forks.length}`,
      },
    });
  }

  invalidateInstructions(thread: Thread): void {
    this.invalidated.push(thread.id);
  }

  async startTurn(): Promise<void> {}

  async startSystemTurn(thread: Thread, text: string, opts?: { caption?: string }): Promise<void> {
    this.systemTurns.push({ threadId: thread.id, text, caption: opts?.caption });
    await this.turnGate;
  }

  async interrupt(): Promise<void> {}
  turnInFlight(): boolean {
    return this.inFlight;
  }
  inFlightThreads(): string[] {
    return [];
  }
  async resumeAll(): Promise<void> {}
}

function fakeDashboard(scores: number[]) {
  let call = 0;
  return {
    calls: () => call,
    get(): Promise<DashboardData> {
      const score = scores[Math.min(call, scores.length - 1)] ?? 0;
      call += 1;
      return Promise.resolve({
        user: { displayName: 'X', streakDays: 0 },
        readiness: [
          {
            track: TRACK,
            displayName: 'SQL Interview Prep',
            score,
            delta7d: 0,
            weakest: [
              { concept: 'window-functions', name: 'Window functions', effective: 0 },
              { concept: 'left-join', name: 'LEFT JOIN', effective: 0.31 },
            ],
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
}

function recordingSink() {
  const events: Array<{ target: string; id: string; event: WsEvent }> = [];
  return {
    events,
    emitToThread(id: string, event: WsEvent) {
      events.push({ target: 'thread', id, event });
    },
    emitToUser(id: string, event: WsEvent) {
      events.push({ target: 'user', id, event });
    },
  };
}

let prisma: PrismaClient;
let workspaces: WorkspaceManager;
let cleanup: () => Promise<void>;
let threads: FakeThreadService;
let dashboard: ReturnType<typeof fakeDashboard>;
let sink: ReturnType<typeof recordingSink>;
let service: ExamService;
let learnThread: Thread;

beforeEach(async () => {
  prisma = createPrisma(createTestDbUrl('exam-service'));
  await prisma.user.create({
    data: { id: USER_ID, handle: `exam-${Date.now()}`, displayName: 'E', workspacePath: 'x' },
  });
  learnThread = await prisma.thread.create({
    data: {
      userId: USER_ID,
      codexThreadId: `cdx-learn-${Date.now()}`,
      mode: 'learn',
      title: 'learn',
      sessionToken: `tok-learn-${Date.now()}`,
    },
  });
  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);
  await workspaces.ensureWorkspace(USER_ID);
  threads = new FakeThreadService(prisma);
  dashboard = fakeDashboard([50, 50, 60]);
  sink = recordingSink();
  service = new ExamService({ prisma, workspaces, threads, dashboard, sink });
});

afterEach(async () => {
  service.stopSweep();
  await prisma.$disconnect();
  await cleanup();
});

/** Waits for fire-and-forget turn kickoffs to flush through the microtask queue. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

async function createReadyExam(): Promise<string> {
  const { examId } = await service.create(USER_ID, { trackSlug: TRACK, durationMin: 30 });
  await prisma.exam.update({ where: { id: examId }, data: { questions: QUESTIONS, status: 'ready' } });
  await settle();
  return examId;
}

describe('deadline math', () => {
  it('deadline = startedAt + durationMin; grace = 30s', () => {
    const startedAt = new Date('2026-07-17T10:00:00Z');
    expect(examDeadline(startedAt, 30).toISOString()).toBe('2026-07-17T10:30:00.000Z');
    expect(EXAM_GRACE_MS).toBe(30_000);
    expect(examExpired(startedAt, 30, new Date('2026-07-17T10:30:29Z'))).toBe(false);
    expect(examExpired(startedAt, 30, new Date('2026-07-17T10:30:30Z'))).toBe(false);
    expect(examExpired(startedAt, 30, new Date('2026-07-17T10:30:30.001Z'))).toBe(true);
  });
});

describe('create', () => {
  it('forks the latest learn thread, inserts the draft row, and kicks generation', async () => {
    const { examId, status } = await service.create(USER_ID, { trackSlug: TRACK, durationMin: 45 });
    expect(status).toBe('draft');
    await settle();

    expect(threads.forks).toHaveLength(1);
    expect(threads.forks[0]).toMatchObject({ examId, trackSlug: TRACK, durationMin: 45 });
    expect(threads.forks[0]!.targeting.map((t) => t.concept)).toEqual([
      'window-functions',
      'left-join',
    ]);

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.status).toBe('draft');
    expect(exam.userId).toBe(USER_ID);
    const config = parseExamConfig(exam.config);
    expect(config).toMatchObject({ durationMin: 45 });
    expect(config.targeting).toHaveLength(2);

    expect(exam.threadId).not.toBeNull();
    const examThread = await prisma.thread.findUniqueOrThrow({ where: { id: exam.threadId! } });
    expect(examThread.mode).toBe('exam');
    expect(examThread.forkedFromId).toBe(learnThread.id);

    expect(threads.systemTurns).toHaveLength(1);
    expect(threads.systemTurns[0]!.text).toBe('[exam-generate]');
    expect(threads.systemTurns[0]!.caption).toBeTruthy();
  });

  it('rejects an unknown track', async () => {
    await expect(service.create(USER_ID, { trackSlug: 'no-such', durationMin: 30 })).rejects.toThrow(
      UnknownTrackError,
    );
    expect(threads.forks).toHaveLength(0);
  });

  it('pins the exam ignore pattern into .git/info/exclude (idempotently)', async () => {
    await service.create(USER_ID, { trackSlug: TRACK, durationMin: 30 });
    await service.create(USER_ID, { trackSlug: TRACK, durationMin: 30 });
    await settle();
    const exclude = await fs.readFile(
      path.join(workspaces.pathFor(USER_ID), '.git', 'info', 'exclude'),
      'utf8',
    );
    const occurrences = exclude.split('\n').filter((l) => l === EXAM_IGNORE_PATTERN);
    expect(occurrences).toHaveLength(1);
  });

  it('emits a retryable turn.error when generation settles without ui_create_exam', async () => {
    await service.create(USER_ID, { trackSlug: TRACK, durationMin: 30 });
    await settle();
    const errors = sink.events.filter(
      (e) => e.target === 'user' && e.id === USER_ID && e.event.type === 'turn.error',
    );
    expect(errors).toHaveLength(1);
  });
});

describe('state machine', () => {
  it('start: draft cannot start; ready → in_progress; second start is idempotent', async () => {
    const { examId } = await service.create(USER_ID, { trackSlug: TRACK, durationMin: 30 });
    await settle();
    await expect(service.start(USER_ID, examId)).rejects.toThrow(ExamStateError);

    await prisma.exam.update({ where: { id: examId }, data: { questions: QUESTIONS, status: 'ready' } });
    const first = await service.start(USER_ID, examId);
    expect(first).not.toBeNull();
    expect(first!.deadline.getTime() - first!.startedAt.getTime()).toBe(30 * 60_000);

    const again = await service.start(USER_ID, examId);
    expect(again!.startedAt.getTime()).toBe(first!.startedAt.getTime());

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.status).toBe('in_progress');
  });

  it('ownership: another user sees null everywhere', async () => {
    const examId = await createReadyExam();
    await prisma.user.create({
      data: { id: 'user-other', handle: `other-${Date.now()}`, displayName: 'O', workspacePath: 'x' },
    });
    expect(await service.get('user-other', examId)).toBeNull();
    expect(await service.start('user-other', examId)).toBeNull();
    expect(await service.autosave('user-other', examId, {})).toBeNull();
    expect(await service.submit('user-other', examId, {})).toBeNull();
  });

  it('autosave: only in_progress, and only inside deadline+grace', async () => {
    const examId = await createReadyExam();
    await expect(service.autosave(USER_ID, examId, { q1: 'x' })).rejects.toThrow(ExamStateError);

    await service.start(USER_ID, examId);
    await service.autosave(USER_ID, examId, { q1: 'SELECT 1;' });
    let exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.answers).toMatchObject({ q1: 'SELECT 1;' });

    // Inside grace: allowed. Past grace: rejected, answers untouched.
    const startedAt = exam.startedAt!;
    const insideGrace = new Date(startedAt.getTime() + 30 * 60_000 + EXAM_GRACE_MS - 1_000);
    await service.autosave(USER_ID, examId, { q1: 'SELECT 2;' }, insideGrace);
    const pastGrace = new Date(startedAt.getTime() + 30 * 60_000 + EXAM_GRACE_MS + 1_000);
    await expect(service.autosave(USER_ID, examId, { q1: 'late' }, pastGrace)).rejects.toThrow(
      DeadlinePassedError,
    );
    exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.answers).toMatchObject({ q1: 'SELECT 2;' });
  });

  it('submit: persists answers, writes coding submissions, snapshots readiness, rotates instructions, kicks grading', async () => {
    const examId = await createReadyExam();
    await service.start(USER_ID, examId);
    const before = threads.systemTurns.length;

    const result = await service.submit(USER_ID, examId, { q1: 'SELECT 42;', q2: '5' });
    expect(result).toEqual({ autoSubmitted: false });
    await settle();

    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(exam.status).toBe('submitted');
    expect(exam.submittedAt).not.toBeNull();
    expect(exam.answers).toMatchObject({ q1: 'SELECT 42;', q2: '5' });
    expect(parseExamConfig(exam.config).readinessBefore).toBe(50);

    const submission = await fs.readFile(
      path.join(workspaces.pathFor(USER_ID), '.exercises', `exam-${examId}-q1`, 'submission.sql'),
      'utf8',
    );
    expect(submission).toBe('SELECT 42;');

    expect(threads.invalidated).toContain(exam.threadId);
    const grading = threads.systemTurns.slice(before);
    expect(grading).toHaveLength(1);
    expect(grading[0]!.text).toContain(`exam ${examId}`);
    expect(grading[0]!.text).toContain('submission.sql');
    expect(grading[0]!.text).toContain('q2 (mcq, 5 pts): "5"');
  });

  it('submit past deadline+grace ignores the body and uses autosaved answers', async () => {
    const examId = await createReadyExam();
    await service.start(USER_ID, examId);
    await service.autosave(USER_ID, examId, { q1: 'autosaved' });
    const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    const late = new Date(exam.startedAt!.getTime() + 30 * 60_000 + EXAM_GRACE_MS + 1_000);

    const result = await service.submit(USER_ID, examId, { q1: 'sneaky-late-answer' }, late);
    expect(result).toEqual({ autoSubmitted: true });
    await settle();

    const after = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
    expect(after.status).toBe('submitted');
    expect(after.answers).toMatchObject({ q1: 'autosaved' });
    const gradingTurn = threads.systemTurns.at(-1)!;
    expect(gradingTurn.text).toContain('time expired');
  });

  it('submit on ready/graded is rejected; submitted-without-result re-kicks grading', async () => {
    const examId = await createReadyExam();
    await expect(service.submit(USER_ID, examId, {})).rejects.toThrow(ExamStateError);

    await service.start(USER_ID, examId);
    await service.submit(USER_ID, examId, { q1: 'x' });
    await settle();
    const turnsAfterFirst = threads.systemTurns.length;

    // Grading turn died without ui_grade_exam → still submitted → retry allowed.
    await service.submit(USER_ID, examId, {});
    await settle();
    expect(threads.systemTurns.length).toBe(turnsAfterFirst + 1);

    // …but not while a grading turn is in flight.
    threads.inFlight = true;
    await expect(service.submit(USER_ID, examId, {})).rejects.toThrow(ExamStateError);
    threads.inFlight = false;

    await prisma.exam.update({
      where: { id: examId },
      data: { status: 'graded', result: { per_question: [], total: 0, readiness_delta: 0 } },
    });
    await expect(service.submit(USER_ID, examId, {})).rejects.toThrow(ExamStateError);
  });

  it('emits a retryable turn.error when grading settles without ui_grade_exam', async () => {
    const examId = await createReadyExam();
    await service.start(USER_ID, examId);
    sink.events.length = 0;
    await service.submit(USER_ID, examId, { q1: 'x' });
    await settle();
    const errors = sink.events.filter(
      (e) => e.target === 'user' && e.event.type === 'turn.error',
    );
    expect(errors).toHaveLength(1);
    expect((errors[0]!.event as { message: string }).message).toMatch(/grading/i);
  });
});

describe('sweep', () => {
  it('auto-submits only expired in_progress exams, with their autosaved answers', async () => {
    const expired = await createReadyExam();
    await service.start(USER_ID, expired);
    await service.autosave(USER_ID, expired, { q1: 'best effort' });
    await prisma.exam.update({
      where: { id: expired },
      data: { startedAt: new Date(Date.now() - 31 * 60_000 - EXAM_GRACE_MS) },
    });

    const running = await createReadyExam();
    await service.start(USER_ID, running);

    const fresh = await createReadyExam(); // ready, never started

    const swept = await service.sweepExpired();
    await settle();
    expect(swept).toBe(1);

    expect((await prisma.exam.findUniqueOrThrow({ where: { id: expired } })).status).toBe('submitted');
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: running } })).status).toBe('in_progress');
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: fresh } })).status).toBe('ready');

    const gradingTurn = threads.systemTurns.at(-1)!;
    expect(gradingTurn.text).toContain('time expired');
    expect(gradingTurn.text).toContain('submission.sql'); // autosaved q1 written to disk
  });

  it('a submit racing the sweep at the deadline starts exactly one grading turn', async () => {
    const examId = await createReadyExam();
    await service.start(USER_ID, examId);
    await service.autosave(USER_ID, examId, { q1: 'autosaved' });
    await prisma.exam.update({
      where: { id: examId },
      data: { startedAt: new Date(Date.now() - 31 * 60_000 - EXAM_GRACE_MS) },
    });

    const before = threads.systemTurns.length;
    // Both paths read `in_progress` before either lands the transition — the
    // conditional update must let exactly one of them start grading.
    const [submitResult] = await Promise.allSettled([
      service.submit(USER_ID, examId, { q1: 'late body (ignored)' }),
      service.sweepExpired(),
    ]);
    await settle();

    expect(submitResult.status).toBe('fulfilled');
    expect((await prisma.exam.findUniqueOrThrow({ where: { id: examId } })).status).toBe('submitted');
    const gradingTurns = threads.systemTurns.slice(before).filter((t) => t.text.includes(examId));
    expect(gradingTurns).toHaveLength(1);
  });
});

describe('fork failure', () => {
  it('maps a failing thread fork to ExamForkError and leaves no Exam row behind', async () => {
    threads.forkForExam = () => Promise.reject(new Error('no rollout found'));
    await expect(service.create(USER_ID, { trackSlug: TRACK, durationMin: 30 })).rejects.toThrow(
      ExamForkError,
    );
    expect(await prisma.exam.count({ where: { userId: USER_ID } })).toBe(0);
  });
});
