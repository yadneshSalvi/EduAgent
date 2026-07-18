import type { PrismaClient, Thread } from '@prisma/client';
import type { WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppServerClient } from '../src/codex/index.js';
import { createPrisma } from '../src/db.js';
import { maskExamArtifacts, ThreadManager } from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { FakeAppServer, fakeSpawner, type WireMessage } from './helpers/fake-appserver.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * ThreadManager's exam surface against the scripted FakeAppServer:
 * forkForExam sends thread/fork and persists the row (mode exam,
 * forkedFromId, fresh token, no greeting); the fork's FIRST turn re-resumes
 * AND injects the exam-generate template (as a developer message via
 * thread/inject_items) rebuilt from the Exam row — mandatory because codex
 * 0.144.4 drops developerInstructions on BOTH thread/fork and thread/resume
 * (Phase 4 E2E finding, PROTOCOL_NOTES addendum) — and rotation injects the
 * exam-grade template once the Exam row is `submitted`.
 */

const USER_ID = 'user-fork-1';

function recordingSink() {
  const records: Array<{ target: string; id: string; event: WsEvent }> = [];
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

const memoryStub = {
  beforeTurn: () => Promise.resolve(null),
  afterTurn: () => Promise.resolve([]),
};

let prisma: PrismaClient;
let client: AppServerClient;
let manager: ThreadManager;
let workspaces: WorkspaceManager;
let cleanupDataDir: () => Promise<void>;
let fake: FakeAppServer;
let sink: ReturnType<typeof recordingSink>;
let parent: Thread;
const counters = { turn: 0 };

/** Scripts a minimal completed turn for any turn/start. */
function scriptTurns(child: FakeAppServer): void {
  child.onMethod('turn/start', (msg: WireMessage) => {
    const { threadId } = msg.params as { threadId: string };
    counters.turn += 1;
    const turnId = `turn-${counters.turn}`;
    child.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
    child.notifyClient('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', error: null },
    });
  });
}

beforeEach(async () => {
  prisma = createPrisma(createTestDbUrl('exam-fork'));
  await prisma.user.create({
    data: { id: USER_ID, handle: `fork-${Date.now()}`, displayName: 'F', workspacePath: 'x' },
  });
  parent = await prisma.thread.create({
    data: {
      userId: USER_ID,
      codexThreadId: 'cdx-parent-learn',
      mode: 'learn',
      title: 'learn',
      sessionToken: 'tok-parent-learn',
    },
  });
  // The parent has turn history (an agent item) — codex has its rollout, so
  // forkForExam forks without a warm-up turn. The turnless case has its own test.
  await prisma.itemMirror.create({
    data: {
      threadId: parent.id,
      role: 'agent',
      kind: 'message',
      payload: { text: 'Welcome back.', phase: 'final_answer' },
    },
  });

  const dataDir = createTestDataDir();
  cleanupDataDir = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);

  const spawner = fakeSpawner((child) => {
    child.onMethod('thread/fork', (msg) => {
      child.respond(msg.id as number, { thread: { id: 'cdx-forked-exam' } });
    });
    child.onMethod('thread/resume', (msg) => {
      child.respond(msg.id as number, {
        thread: { id: (msg.params as { threadId: string }).threadId },
      });
    });
    child.onMethod('thread/inject_items', (msg) => {
      child.respond(msg.id as number, {});
    });
    scriptTurns(child);
  });
  client = new AppServerClient({
    codexBin: 'codex',
    defaultModel: 'gpt-test',
    spawnFn: spawner.spawnFn,
  });
  await client.start();
  fake = spawner.spawns[0]!.child;

  sink = recordingSink();
  manager = new ThreadManager({ prisma, client, workspaces, memory: memoryStub, sink });
});

afterEach(async () => {
  manager.close();
  await client.close();
  await prisma.$disconnect();
  await cleanupDataDir();
});

const FORK_OPTS = {
  examId: 'exam-abc',
  trackSlug: 'sql-interview',
  durationMin: 30,
  targeting: [{ concept: 'left-join', name: 'LEFT JOIN', effective: 0.31 }],
};

/** The developer-message text of a captured thread/inject_items call. */
function injectedText(msg: WireMessage): string {
  const { items } = msg.params as {
    items: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
  };
  expect(items).toHaveLength(1);
  expect(items[0]!.role).toBe('developer');
  return items[0]!.content.map((c) => c.text).join('\n');
}

describe('forkForExam', () => {
  it('sends thread/fork with cwd (+ forward-compat instructions) and persists the row', async () => {
    const thread = await manager.forkForExam(parent, FORK_OPTS);

    const forkMsg = fake.received.find((m) => m.method === 'thread/fork')!;
    expect(forkMsg).toBeDefined();
    const params = forkMsg.params as {
      threadId: string;
      cwd: string;
      developerInstructions: string;
    };
    expect(params.threadId).toBe(parent.codexThreadId);
    expect(params.cwd).toBe(workspaces.pathFor(USER_ID));
    // Passed for forward-compat even though 0.144.4 ignores them at fork.
    expect(params.developerInstructions).toContain('EXAM GENERATION');
    expect(params.developerInstructions).toContain(thread.sessionToken);

    expect(thread.mode).toBe('exam');
    expect(thread.forkedFromId).toBe(parent.id);
    expect(thread.trackSlug).toBe('sql-interview');
    expect(thread.codexThreadId).toBe('cdx-forked-exam');
    expect(thread.sessionToken).not.toBe(parent.sessionToken);

    // No auto-greeting: the generation turn is the fork's first turn.
    expect(fake.received.filter((m) => m.method === 'turn/start')).toHaveLength(0);
  });

  it('runs the parent greeting first when the parent has no completed turn (rollout precondition)', async () => {
    const turnless = await prisma.thread.create({
      data: {
        userId: USER_ID,
        codexThreadId: 'cdx-parent-turnless',
        mode: 'learn',
        title: 'learn',
        sessionToken: 'tok-parent-turnless',
      },
    });
    // The warm-up greeting must LAND agent items (that's the history signal);
    // rescript turn/start to stream one agentMessage before completing.
    fake.onMethod('turn/start', (msg: WireMessage) => {
      const { threadId } = msg.params as { threadId: string };
      counters.turn += 1;
      const turnId = `turn-${counters.turn}`;
      fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
      fake.notifyClient('item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: `greet-${turnId}`, text: 'Hi!', phase: 'final_answer' },
        completedAtMs: Date.now(),
      });
      fake.notifyClient('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'completed', error: null },
      });
    });

    const thread = await manager.forkForExam(turnless, FORK_OPTS);
    expect(thread.mode).toBe('exam');

    const methods = fake.received
      .filter((m) => m.method === 'turn/start' || m.method === 'thread/fork')
      .map((m) => m.method);
    expect(methods).toEqual(['turn/start', 'thread/fork']);
    const greeting = fake.received.find((m) => m.method === 'turn/start')!;
    expect((greeting.params as { threadId: string }).threadId).toBe('cdx-parent-turnless');
  });

  it('resumes AND injects the exam-generate template before the first turn (0.144.4 drops resume/fork instructions)', async () => {
    const thread = await manager.forkForExam(parent, FORK_OPTS);
    await prisma.exam.create({
      data: {
        id: 'exam-abc',
        userId: USER_ID,
        threadId: thread.id,
        trackSlug: 'sql-interview',
        config: { durationMin: 30, targeting: FORK_OPTS.targeting },
        questions: {},
        status: 'draft',
      },
    });
    await manager.startSystemTurn(thread, '[exam-generate]');
    const resumes = fake.received.filter((m) => m.method === 'thread/resume');
    expect(resumes).toHaveLength(1);
    const params = resumes[0]!.params as { threadId: string; developerInstructions: string };
    expect(params.threadId).toBe('cdx-forked-exam');
    expect(params.developerInstructions).toContain('EXAM GENERATION');

    // The channel that actually reaches the model: a developer message via
    // thread/inject_items, carrying the supersession preamble + template.
    const injects = fake.received.filter((m) => m.method === 'thread/inject_items');
    expect(injects).toHaveLength(1);
    expect((injects[0]!.params as { threadId: string }).threadId).toBe('cdx-forked-exam');
    const text = injectedText(injects[0]!);
    expect(text).toContain('INSTRUCTION UPDATE');
    expect(text).toContain('supersedes ALL earlier developer instructions');
    expect(text).toContain('EXAM GENERATION');
    expect(text).toContain('exam-abc');
    expect(text).toContain('left-join');
    expect(text).toContain(thread.sessionToken);
    expect(text).not.toContain(parent.sessionToken);

    expect(fake.received.filter((m) => m.method === 'turn/start')).toHaveLength(1);
    const resumeIndex = fake.received.indexOf(resumes[0]!);
    const injectIndex = fake.received.indexOf(injects[0]!);
    const turnIndex = fake.received.findIndex((m) => m.method === 'turn/start');
    expect(resumeIndex).toBeLessThan(injectIndex);
    expect(injectIndex).toBeLessThan(turnIndex);
  });
});

describe('instruction rotation (generate → grade)', () => {
  it('injects exam-grade instructions after invalidateInstructions on a submitted exam', async () => {
    const thread = await manager.forkForExam(parent, FORK_OPTS);
    await prisma.exam.create({
      data: {
        id: 'exam-abc',
        userId: USER_ID,
        threadId: thread.id,
        trackSlug: 'sql-interview',
        config: { durationMin: 30, targeting: FORK_OPTS.targeting, readinessBefore: 47.5 },
        questions: {},
        status: 'submitted',
      },
    });

    manager.invalidateInstructions(thread);
    await manager.startSystemTurn(thread, 'grade it');

    const injects = fake.received.filter((m) => m.method === 'thread/inject_items');
    expect(injects).toHaveLength(1);
    expect((injects[0]!.params as { threadId: string }).threadId).toBe('cdx-forked-exam');
    const text = injectedText(injects[0]!);
    expect(text).toContain('EXAM GRADING');
    expect(text).toContain('exam-abc');
    expect(text).toContain('47.5');
    expect(text).toContain(thread.sessionToken);
    expect(text).not.toContain('EXAM GENERATION');
  });

  it('resume on an exam thread with a draft exam rebuilds the generate template', async () => {
    const thread = await manager.forkForExam(parent, FORK_OPTS);
    await prisma.exam.create({
      data: {
        id: 'exam-abc',
        userId: USER_ID,
        threadId: thread.id,
        trackSlug: 'sql-interview',
        config: { durationMin: 30, targeting: FORK_OPTS.targeting },
        questions: {},
        status: 'draft',
      },
    });
    manager.invalidateInstructions(thread);
    await manager.startSystemTurn(thread, '[exam-generate]');
    const injects = fake.received.filter((m) => m.method === 'thread/inject_items');
    expect(injects).toHaveLength(1);
    expect(injectedText(injects[0]!)).toContain('EXAM GENERATION');
  });
});

describe('exam exec redaction + label masking (QA F3)', () => {
  /** The examiner's shell traffic — every line names an answer-key artifact. */
  const LEAKY_COMMAND =
    "/bin/zsh -lc 'python3 tests/test_query.py solution.sql && cat .exercises/exam-abc-key/rubric.md'";

  it('masks giveaway filenames but keeps the command theater', () => {
    expect(maskExamArtifacts('python3 tests/test_query.py solution.sql')).toBe(
      'python3 tests/test_query.py ████',
    );
    expect(maskExamArtifacts('cat .exercises/exam-568833e2-2860-key/rubric.md')).toBe(
      'cat .exercises/exam-████/████',
    );
    expect(maskExamArtifacts('diff answers.json expected.txt')).toBe('diff ████ ████');
    // Non-sensitive commands pass through untouched — the theater survives.
    expect(maskExamArtifacts('sed -n 1,40p topics/sql/mastery.yaml')).toBe(
      'sed -n 1,40p topics/sql/mastery.yaml',
    );
    expect(maskExamArtifacts('git add -A && git commit -m "exam(sql): graded"')).toBe(
      'git add -A && git commit -m "exam(sql): graded"',
    );
  });

  it('exam-thread exec rows and live activity labels never spell out key artifacts', async () => {
    const thread = await manager.forkForExam(parent, FORK_OPTS);
    await prisma.exam.create({
      data: {
        id: 'exam-abc',
        userId: USER_ID,
        threadId: thread.id,
        trackSlug: 'sql-interview',
        config: { durationMin: 30, targeting: FORK_OPTS.targeting },
        questions: {},
        status: 'draft',
      },
    });

    fake.onMethod('turn/start', (msg: WireMessage) => {
      const { threadId } = msg.params as { threadId: string };
      counters.turn += 1;
      const turnId = `turn-${counters.turn}`;
      const exec = {
        type: 'commandExecution',
        id: `exec-${turnId}`,
        command: LEAKY_COMMAND,
        cwd: '/w',
        processId: null,
        source: 'agent',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: 'SECRET hidden-test output: expected 42 rows',
        exitCode: 0,
        durationMs: 42,
      };
      fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
      fake.notifyClient('item/started', {
        threadId,
        turnId,
        item: { ...exec, status: 'inProgress', aggregatedOutput: null, exitCode: null },
        startedAtMs: Date.now(),
      });
      fake.notifyClient('item/completed', {
        threadId,
        turnId,
        item: exec,
        completedAtMs: Date.now(),
      });
      fake.notifyClient('turn/completed', {
        threadId,
        turn: { id: turnId, status: 'completed', error: null },
      });
    });

    await manager.startSystemTurn(thread, '[exam-generate]');

    // Live activity labels (the generation/grading terminal card) are masked.
    const labels = sink.records
      .filter((r) => r.event.type === 'activity')
      .map((r) => (r.event as { label: string }).label);
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) {
      expect(label).not.toContain('solution.');
      expect(label).not.toContain('rubric');
      expect(label).not.toContain('-key');
      expect(label).toContain('python3 tests/test_query.py');
    }

    // The mirrored row carries exactly that masked label and nothing more.
    const rows = await prisma.itemMirror.findMany({
      where: { threadId: thread.id, kind: 'exec' },
    });
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as { command: string; aggregatedOutput: string | null };
    expect(payload.aggregatedOutput).toBeNull();
    expect(payload.command).toBe(labels[0]);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('solution.sql');
    expect(serialized).not.toContain('rubric.md');
    expect(serialized).not.toContain('exam-abc-key');
    expect(serialized).not.toContain('SECRET');
  });
});
