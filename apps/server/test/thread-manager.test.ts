import path from 'node:path';
import fs from 'node:fs/promises';
import type { PrismaClient, Thread } from '@prisma/client';
import type { WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppServerClient } from '../src/codex/index.js';
import { createPrisma } from '../src/db.js';
import { GREETING_INPUT, ThreadManager } from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import type { AppConfig } from '../src/config.js';
import { FakeAppServer, fakeSpawner, type WireMessage } from './helpers/fake-appserver.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * ThreadManager against a scripted FakeAppServer (no real codex): ensure /
 * resume, per-thread queueing, ItemMirror writes, WsEvent mapping incl.
 * turnAborted → turn.error, and greeting-on-create (plans/03 §3.1).
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
    async until(predicate: (r: SinkRecord) => boolean, timeoutMs = 5_000): Promise<SinkRecord> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = records.find(predicate);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `sink.until timed out; saw: ${records.map((r) => r.event.type).join(',')}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

/** Fake memory pipeline: records calls, returns no commits. */
function recordingMemory() {
  const calls: Array<{ method: 'beforeTurn' | 'afterTurn'; args: unknown }> = [];
  return {
    calls,
    beforeTurn(userId: string) {
      calls.push({ method: 'beforeTurn', args: userId });
      return Promise.resolve('sha-before');
    },
    afterTurn(ctx: unknown) {
      calls.push({ method: 'afterTurn', args: ctx });
      return Promise.resolve([]);
    },
  };
}

/** Scripts a complete canned turn on any turn/start request. */
function scriptCannedTurns(fake: FakeAppServer, counters: { turn: number }) {
  fake.onMethod('turn/start', (msg: WireMessage) => {
    const { threadId } = msg.params as { threadId: string };
    counters.turn += 1;
    const turnId = `turn-${counters.turn}`;
    const itemId = `msg-${turnId}`;
    fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
    fake.notifyClient('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    fake.notifyClient('item/started', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: itemId, text: '', phase: 'final_answer' },
      startedAtMs: Date.now(),
    });
    fake.notifyClient('item/agentMessage/delta', { threadId, turnId, itemId, delta: 'Hi ' });
    fake.notifyClient('item/agentMessage/delta', { threadId, turnId, itemId, delta: 'there' });
    fake.notifyClient('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: itemId, text: 'Hi there', phase: 'final_answer' },
      completedAtMs: Date.now(),
    });
    fake.notifyClient('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', error: null },
    });
  });
}

let prisma: PrismaClient;
let client: AppServerClient;
let manager: ThreadManager;
let workspaces: WorkspaceManager;
let cleanupDataDir: () => Promise<void>;
let config: AppConfig;
let fake: FakeAppServer;
let spawns: ReturnType<typeof fakeSpawner>['spawns'];
let sink: ReturnType<typeof recordingSink>;
let memory: ReturnType<typeof recordingMemory>;
const counters = { thread: 0, turn: 0 };
const USER_ID = 'user-tm-1';

beforeEach(async () => {
  prisma = createPrisma(createTestDbUrl('thread-manager'));
  await prisma.user.create({
    data: { id: USER_ID, handle: `tm-${Date.now()}`, displayName: 'TM', workspacePath: 'x' },
  });

  const dataDir = createTestDataDir();
  config = dataDir.config;
  cleanupDataDir = dataDir.cleanup;
  workspaces = new WorkspaceManager(config);

  const spawner = fakeSpawner((child) => {
    child.onMethod('thread/start', (msg) => {
      counters.thread += 1;
      child.respond(msg.id as number, { thread: { id: `cdx-${counters.thread}` } });
    });
    child.onMethod('thread/resume', (msg) => {
      child.respond(msg.id as number, {
        thread: { id: (msg.params as { threadId: string }).threadId },
      });
    });
  });
  spawns = spawner.spawns;
  client = new AppServerClient({
    codexBin: 'codex',
    defaultModel: 'gpt-test',
    spawnFn: spawner.spawnFn,
    backoff: { initialMs: 10, stableMs: 10_000 },
  });
  await client.start();
  fake = spawns[0]!.child;

  sink = recordingSink();
  memory = recordingMemory();
  manager = new ThreadManager({ prisma, client, workspaces, memory, sink });
});

afterEach(async () => {
  manager.close();
  await client.close();
  await prisma.$disconnect();
  await cleanupDataDir();
});

describe('ensureThread', () => {
  it('creates workspace + codex thread + row, and runs the greeting turn', async () => {
    scriptCannedTurns(fake, counters);
    const { thread, created } = await manager.ensureThread(USER_ID, 'learn');
    expect(created).toBe(true);
    expect(thread.codexThreadId).toMatch(/^cdx-/);
    expect(thread.sessionToken).toHaveLength(36);
    expect(thread.mode).toBe('learn');

    const started = await fake.waitFor((m) => m.method === 'thread/start');
    const params = started.params as { cwd: string; developerInstructions: string };
    expect(params.cwd).toBe(workspaces.pathFor(USER_ID));
    // Un-onboarded learner ⇒ onboarding instructions carrying the session token.
    expect(params.developerInstructions).toContain('ONBOARDING');
    expect(params.developerInstructions).toContain(thread.sessionToken);

    await sink.until((r) => r.event.type === 'turn.completed' && r.target === 'thread');
    const rows = await prisma.itemMirror.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => ({ role: r.role, kind: r.kind }))).toEqual([
      { role: 'system', kind: 'message' },
      { role: 'agent', kind: 'message' },
    ]);
    expect(rows[0]!.payload).toMatchObject({ text: GREETING_INPUT });
    // Agent rows use the codex item id so streamed and refetched items dedupe.
    expect(rows[1]!.id).toBe('msg-turn-1');
    expect(rows[1]!.codexItemId).toBe('msg-turn-1');
    expect(rows[1]!.payload).toMatchObject({ text: 'Hi there' });

    // The greeting's turn/start input is the envelope + the fixed line.
    const turnStart = await fake.waitFor((m) => m.method === 'turn/start');
    const input = (turnStart.params as { input: Array<{ text: string }> }).input[0]!.text;
    expect(input).toContain('<eduagent-context>');
    expect(input.endsWith(GREETING_INPUT)).toBe(true);

    // Every turn must carry the pinned sandbox AND re-grant the workspace .git
    // (PROTOCOL_NOTES Phase 1 addendum: workspaceWrite marks it read-only).
    expect((turnStart.params as { sandboxPolicy: unknown }).sandboxPolicy).toEqual({
      type: 'workspaceWrite',
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: true,
      writableRoots: [path.join(workspaces.pathFor(USER_ID), '.git')],
    });
    expect((turnStart.params as { approvalPolicy: string }).approvalPolicy).toBe('never');
  });

  it('returns the existing active thread without a second thread/start', async () => {
    scriptCannedTurns(fake, counters);
    const first = await manager.ensureThread(USER_ID, 'learn', { topicSlug: 'sql' });
    await sink.until((r) => r.event.type === 'turn.completed');
    const before = fake.received.filter((m) => m.method === 'thread/start').length;
    const second = await manager.ensureThread(USER_ID, 'learn', { topicSlug: 'sql' });
    expect(second.created).toBe(false);
    expect(second.thread.id).toBe(first.thread.id);
    expect(fake.received.filter((m) => m.method === 'thread/start').length).toBe(before);
  });

  it('legacy ensureThread never captures a track session sharing the topic', async () => {
    scriptCannedTurns(fake, counters);
    const trackSession = await prisma.thread.create({
      data: {
        userId: USER_ID,
        codexThreadId: 'cdx-track-sql',
        mode: 'learn',
        topicSlug: 'sql',
        trackSlug: 'sql-interview',
        roadmapDay: 3,
        intent: 'teach',
        title: 'Day 3 — joins',
        sessionToken: 'tok-track-sql',
      },
    });
    const ensured = await manager.ensureThread(USER_ID, 'learn', { topicSlug: 'sql' });
    expect(ensured.created).toBe(true);
    expect(ensured.thread.id).not.toBe(trackSession.id);
    expect(ensured.thread.roadmapDay).toBeNull();
  });

  it('rejects exam mode (forked by ExamService, never created directly)', async () => {
    await expect(manager.ensureThread(USER_ID, 'exam')).rejects.toThrow(/not creatable/);
  });

  it('creates review threads with review instructions + REVIEW DUE envelope notes', async () => {
    scriptCannedTurns(fake, counters);
    const { thread, created } = await manager.ensureThread(USER_ID, 'review');
    expect(created).toBe(true);
    expect(thread.mode).toBe('review');
    expect(thread.title).toBe('Review session');

    const started = await fake.waitFor((m) => m.method === 'thread/start');
    const instructions = (started.params as { developerInstructions: string })
      .developerInstructions;
    expect(instructions).toContain('Mode: REVIEW');
    expect(instructions).toContain('ui_push_quiz');
    expect(instructions).toContain(thread.sessionToken);

    // The greeting turn's envelope carries the full due list (empty queue on
    // this fresh workspace → the explicit "nothing is due" directive).
    await sink.until((r) => r.event.type === 'turn.completed');
    const turnStart = await fake.waitFor((m) => m.method === 'turn/start');
    const input = (turnStart.params as { input: Array<{ text: string }> }).input[0]!.text;
    expect(input).toContain('REVIEW DUE');
    expect(input).toContain('nothing is due');
  });

  it('always creates new track sessions and composes teach/revise/real-mistakes instructions', async () => {
    scriptCannedTurns(fake, counters);
    await workspaces.ensureWorkspace(USER_ID);
    const write = async (rel: string, content: string) => {
      const absolute = path.join(workspaces.pathFor(USER_ID), rel);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, content, 'utf8');
    };
    await write(
      'tracks/sql-interview/track.yaml',
      'track: sql-interview\ndisplay_name: SQL\nitems:\n  - concept: joins\n    topic: sql\n    weight: 1\n',
    );
    await write(
      'tracks/sql-interview/roadmap.yaml',
      [
        'track: sql-interview',
        'created: 2026-07-19',
        'schedule:',
        '  study_days: [mon, wed, fri]',
        '  minutes_per_day: 45',
        '  start_date: 2026-07-19',
        'days:',
        ...Array.from({ length: 5 }, (_, index) =>
          [
            `  - day: ${index + 1}`,
            `    title: Topic ${index + 1}`,
            '    status: upcoming',
            '    topics:',
            '      - topic: sql',
            '        concepts: [joins]',
            '    subtopics: [Join keys, Result shapes]',
          ].join('\n'),
        ),
      ].join('\n') + '\n',
    );
    await write(
      'topics/sql/misconceptions.md',
      '## [OPEN] JOIN key confusion\n\n- concepts: [joins]\n- Evidence: matched on the wrong key.\n',
    );
    await write(
      'sessions/2026-07-18-joins.md',
      '---\ndate: 2026-07-18\nmode: learn\ntrack: sql-interview\nroadmap_day: 1\ntitle: Joins\ntopics: [sql]\nduration_estimate: 20m\nconcepts_touched: [joins]\nnext_time: Re-test the wrong-key case\n---\n',
    );
    await workspaces.git(USER_ID).commitAll('plan(sql-interview): create roadmap — 5 days');
    const exercise = await prisma.exercise.create({
      data: {
        userId: USER_ID,
        threadId: 'historical',
        slug: 'ex-joins',
        language: 'sql',
        title: 'Join the orders',
        prompt: 'Join orders and users.',
        starterCode: '',
        concepts: ['joins'],
        difficulty: 'medium',
        status: 'failed',
      },
    });
    await prisma.exerciseAttempt.create({
      data: {
        exerciseId: exercise.id,
        code: 'SELECT 1',
        verdict: 'failed',
        feedback: 'Used customer_id instead of user_id.',
      },
    });

    const teach = await manager.createTrackSession(USER_ID, {
      trackSlug: 'sql-interview',
      day: 1,
      intent: 'teach',
    });
    const revise = await manager.createTrackSession(USER_ID, {
      trackSlug: 'sql-interview',
      day: 1,
      intent: 'revise',
    });
    const mistakes = await manager.createTrackSession(USER_ID, {
      trackSlug: 'sql-interview',
      day: 1,
      intent: 'mistakes',
    });
    expect(new Set([teach.id, revise.id, mistakes.id]).size).toBe(3);
    expect(teach).toMatchObject({ roadmapDay: 1, intent: 'teach', title: 'Day 1 — Topic 1' });
    expect(revise.title).toBe('Day 1 — revisited');
    expect(mistakes.title).toBe('Day 1 — fixing gaps');
    const instructions = fake.received
      .filter((message) => message.method === 'thread/start')
      .map(
        (message) => (message.params as { developerInstructions: string }).developerInstructions,
      );
    expect(instructions.at(-3)).toContain('ui_session_wrap');
    expect(instructions.at(-2)).toContain('REVISION');
    expect(instructions.at(-1)).toContain('Used customer_id instead of user_id');
    expect(instructions.at(-1)).toContain('JOIN key confusion');
    expect(instructions.at(-1)).toContain('Re-test the wrong-key case');
  });
});

describe('startTurn', () => {
  /** Inserts a Thread row that the current codex child does NOT know about. */
  async function insertThreadRow(codexThreadId: string): Promise<Thread> {
    return prisma.thread.create({
      data: {
        userId: USER_ID,
        codexThreadId,
        mode: 'learn',
        topicSlug: null,
        title: 'test',
        sessionToken: `tok-${codexThreadId}`,
      },
    });
  }

  it('resumes an unknown thread before the turn, then mirrors + streams it', async () => {
    scriptCannedTurns(fake, counters);
    const thread = await insertThreadRow('cdx-preexisting');
    await manager.startTurn(thread, 'What is a JOIN?');

    const methods = fake.received
      .filter((m) => m.method === 'thread/resume' || m.method === 'turn/start')
      .map((m) => m.method);
    expect(methods).toEqual(['thread/resume', 'turn/start']);
    const resume = fake.received.find((m) => m.method === 'thread/resume');
    expect((resume!.params as { threadId: string }).threadId).toBe('cdx-preexisting');
    expect((resume!.params as { developerInstructions: string }).developerInstructions).toContain(
      'tok-cdx-preexisting',
    );

    // Mirror: raw user text (no envelope), then the agent message.
    const rows = await prisma.itemMirror.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows[0]).toMatchObject({ role: 'user', kind: 'message' });
    expect(rows[0]!.payload).toMatchObject({ text: 'What is a JOIN?' });
    expect(rows[1]).toMatchObject({ role: 'agent', kind: 'message' });

    // WsEvent mapping order on the thread socket.
    const threadEvents = sink.records.filter((r) => r.target === 'thread').map((r) => r.event.type);
    expect(threadEvents).toEqual([
      'turn.started',
      'message.delta',
      'message.delta',
      'message.completed',
      'turn.completed',
    ]);
    // Turn lifecycle also reaches the user socket.
    const userEvents = sink.records.filter((r) => r.target === 'user').map((r) => r.event.type);
    expect(userEvents).toEqual(['turn.started', 'turn.completed']);

    // Memory pipeline bracketed the turn with the captured sha.
    expect(memory.calls[0]).toMatchObject({ method: 'beforeTurn' });
    expect(memory.calls[1]).toMatchObject({
      method: 'afterTurn',
      args: { userId: USER_ID, threadId: thread.id, sinceSha: 'sha-before' },
    });
  });

  it('serializes turns per thread (second turn/start waits for the first)', async () => {
    const turnStarts: WireMessage[] = [];
    let releaseFirst: (() => void) | null = null;
    fake.onMethod('turn/start', (msg) => {
      turnStarts.push(msg);
      const { threadId } = msg.params as { threadId: string };
      const turnId = `turn-q-${turnStarts.length}`;
      fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
      const complete = () =>
        fake.notifyClient('turn/completed', {
          threadId,
          turn: { id: turnId, status: 'completed', error: null },
        });
      if (turnStarts.length === 1) releaseFirst = complete;
      else complete();
    });

    const thread = await insertThreadRow('cdx-queue');
    const first = manager.startTurn(thread, 'first');
    const second = manager.startTurn(thread, 'second');
    await fake.waitFor((m) => m.method === 'turn/start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(turnStarts.length).toBe(1);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(turnStarts.length).toBe(2);
  });

  it('maps exec items to activity chips and mirrors exec/tool_call rows', async () => {
    fake.onMethod('turn/start', (msg) => {
      const { threadId } = msg.params as { threadId: string };
      fake.respond(msg.id as number, { turn: { id: 'turn-exec', status: 'inProgress' } });
      const exec = {
        type: 'commandExecution',
        id: 'exec-1',
        command: '/bin/zsh -lc "pytest"',
        cwd: '/w',
        processId: null,
        source: 'agent',
        status: 'completed',
        commandActions: [],
        aggregatedOutput: '3 passed',
        exitCode: 0,
        durationMs: 42,
      };
      fake.notifyClient('item/started', {
        threadId,
        turnId: 'turn-exec',
        item: { ...exec, status: 'inProgress', aggregatedOutput: null, exitCode: null },
        startedAtMs: Date.now(),
      });
      fake.notifyClient('item/completed', {
        threadId,
        turnId: 'turn-exec',
        item: exec,
        completedAtMs: Date.now(),
      });
      fake.notifyClient('item/completed', {
        threadId,
        turnId: 'turn-exec',
        item: {
          type: 'mcpToolCall',
          id: 'tool-1',
          server: 'eduagent-ui',
          tool: 'ui_push_quiz',
          status: 'failed',
          arguments: {},
          appContext: null,
          pluginId: null,
          result: null,
          error: { message: 'no relay yet' },
          durationMs: 5,
        },
        completedAtMs: Date.now(),
      });
      fake.notifyClient('turn/completed', {
        threadId,
        turn: { id: 'turn-exec', status: 'completed', error: null },
      });
    });

    const thread = await insertThreadRow('cdx-exec');
    await manager.startTurn(thread, 'run the tests');

    const activity = sink.records
      .filter((r) => r.event.type === 'activity')
      .map((r) => r.event as Extract<WsEvent, { type: 'activity' }>);
    expect(activity).toEqual([
      { type: 'activity', kind: 'exec', label: '/bin/zsh -lc "pytest"', status: 'started' },
      { type: 'activity', kind: 'exec', label: '/bin/zsh -lc "pytest"', status: 'completed' },
      { type: 'activity', kind: 'tool', label: 'ui_push_quiz', status: 'failed' },
    ]);

    const rows = await prisma.itemMirror.findMany({
      where: { threadId: thread.id, kind: { in: ['exec', 'tool_call'] } },
    });
    expect(rows.find((r) => r.kind === 'exec')!.payload).toMatchObject({
      command: '/bin/zsh -lc "pytest"',
      exitCode: 0,
      status: 'completed',
    });
    expect(rows.find((r) => r.kind === 'tool_call')!.payload).toMatchObject({
      tool: 'ui_push_quiz',
      status: 'failed',
    });
  });

  it('emits a retryable turn.error when the child dies mid-turn (turnAborted)', async () => {
    fake.onMethod('turn/start', (msg) => {
      fake.respond(msg.id as number, { turn: { id: 'turn-dead', status: 'inProgress' } });
      // No completion: the child dies instead.
      setTimeout(() => fake.exitNow(1), 20);
    });

    const thread = await insertThreadRow('cdx-crash');
    await manager.startTurn(thread, 'this one crashes');

    const error = sink.records.find((r) => r.event.type === 'turn.error');
    expect(error).toBeDefined();
    expect((error!.event as Extract<WsEvent, { type: 'turn.error' }>).retryable).toBe(true);
    // Aborted turns skip the pipeline (no afterTurn call).
    expect(memory.calls.filter((c) => c.method === 'afterTurn')).toHaveLength(0);
  });

  it('emits turn.error (retryable) when the turn completes with status failed', async () => {
    fake.onMethod('turn/start', (msg) => {
      const { threadId } = msg.params as { threadId: string };
      fake.respond(msg.id as number, { turn: { id: 'turn-f', status: 'inProgress' } });
      fake.notifyClient('turn/completed', {
        threadId,
        turn: {
          id: 'turn-f',
          status: 'failed',
          error: { message: 'stream disconnected', codexErrorInfo: null, additionalDetails: null },
        },
      });
    });

    const thread = await insertThreadRow('cdx-fail');
    await manager.startTurn(thread, 'fails');
    const error = sink.records.find((r) => r.event.type === 'turn.error');
    expect(error!.event).toMatchObject({ message: 'stream disconnected', retryable: true });
    // Failed-but-completed turns DO run the pipeline (partial writes get swept).
    expect(memory.calls.filter((c) => c.method === 'afterTurn')).toHaveLength(1);
  });

  it('tracks in-flight turns for snapshots and interrupt', async () => {
    let complete: (() => void) | null = null;
    fake.onMethod('turn/start', (msg) => {
      const { threadId } = msg.params as { threadId: string };
      fake.respond(msg.id as number, { turn: { id: 'turn-live', status: 'inProgress' } });
      complete = () =>
        fake.notifyClient('turn/completed', {
          threadId,
          turn: { id: 'turn-live', status: 'completed', error: null },
        });
    });
    fake.onMethod('turn/interrupt', (msg) => {
      fake.respond(msg.id as number, {});
      complete!();
    });

    const thread = await insertThreadRow('cdx-live');
    const turn = manager.startTurn(thread, 'long one');
    const deadline = Date.now() + 2_000;
    while (!manager.turnInFlight(thread.id)) {
      if (Date.now() > deadline) throw new Error('turn never became in-flight');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(manager.inFlightThreads(USER_ID)).toEqual([thread.id]);

    await manager.interrupt(thread.id);
    await turn;
    const interrupt = fake.received.find((m) => m.method === 'turn/interrupt');
    expect(interrupt!.params).toMatchObject({ threadId: 'cdx-live', turnId: 'turn-live' });
    expect(manager.turnInFlight(thread.id)).toBe(false);
    // Interrupted turns settle the UI with turn.completed, not an error.
    expect(sink.records.at(-1)!.event.type).toBe('turn.completed');
  });
});

describe('per-workspace turn queue (Phase 2 carry-over b)', () => {
  async function insertThreadRow(codexThreadId: string, userId = USER_ID): Promise<Thread> {
    return prisma.thread.create({
      data: {
        userId,
        codexThreadId,
        mode: 'learn',
        topicSlug: null,
        title: 'test',
        sessionToken: `tok-${codexThreadId}`,
      },
    });
  }

  it('serializes turns across DIFFERENT threads of the same user', async () => {
    const turnStarts: WireMessage[] = [];
    let releaseFirst: (() => void) | null = null;
    fake.onMethod('turn/start', (msg) => {
      turnStarts.push(msg);
      const { threadId } = msg.params as { threadId: string };
      const turnId = `turn-ws-${turnStarts.length}`;
      fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
      const complete = () =>
        fake.notifyClient('turn/completed', {
          threadId,
          turn: { id: turnId, status: 'completed', error: null },
        });
      if (turnStarts.length === 1) releaseFirst = complete;
      else complete();
    });

    // Two threads, one workspace: a chat turn and a grading turn overlapping
    // would double-emit commits from overlapping sinceSha ranges.
    const chat = await insertThreadRow('cdx-ws-chat');
    const grading = await insertThreadRow('cdx-ws-grading');
    const first = manager.startTurn(chat, 'chat turn');
    const second = manager.startSystemTurn(grading, 'grading turn');
    await fake.waitFor((m) => m.method === 'turn/start');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(turnStarts.length).toBe(1);
    releaseFirst!();
    await Promise.all([first, second]);
    expect(turnStarts.length).toBe(2);
    // Order preserved: the grading turn went to the grading thread second.
    expect((turnStarts[1]!.params as { threadId: string }).threadId).toBe('cdx-ws-grading');
  });

  it('mirrors system turns with role system (never rendered as the learner)', async () => {
    scriptCannedTurns(fake, counters);
    const thread = await insertThreadRow('cdx-system-role');
    await manager.startSystemTurn(thread, 'The learner submitted ex-001…');
    const rows = await prisma.itemMirror.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows[0]).toMatchObject({ role: 'system', kind: 'message' });
    expect(rows[0]!.payload).toEqual({ text: 'The learner submitted ex-001…' });
  });

  it('mirrors a system-turn caption so reloads never show the raw instructions', async () => {
    scriptCannedTurns(fake, counters);
    const thread = await insertThreadRow('cdx-system-caption');
    await manager.startSystemTurn(thread, 'The learner submitted ex-002…', {
      caption: 'Attempt 1 on ex-002 submitted.',
    });
    const rows = await prisma.itemMirror.findMany({
      where: { threadId: thread.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows[0]!.payload).toEqual({
      text: 'The learner submitted ex-002…',
      caption: 'Attempt 1 on ex-002 submitted.',
    });
  });
});

describe('turn waiter keyed by turn id (Phase 2 carry-over c)', () => {
  it('a late completion after the fail-safe fired must not settle the next queued turn', async () => {
    // Dedicated manager with a small fail-safe ceiling — big enough that
    // turn 2's own ceiling can't fire inside this test's assertion window.
    const shortManager = new ThreadManager({
      prisma,
      client,
      workspaces,
      memory,
      sink,
      turnTimeoutMs: 800,
    });
    try {
      const turnStarts: WireMessage[] = [];
      let completeLate: (() => void) | null = null;
      fake.onMethod('turn/start', (msg) => {
        turnStarts.push(msg);
        const { threadId } = msg.params as { threadId: string };
        const turnId = `turn-late-${turnStarts.length}`;
        fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
        if (turnStarts.length === 1) {
          // Turn 1 hangs past the fail-safe; its completion arrives LATE.
          completeLate = () =>
            fake.notifyClient('turn/completed', {
              threadId,
              turn: { id: turnId, status: 'completed', error: null },
            });
        }
        // Turn 2 stays open until its own completion below.
      });

      const thread = await prisma.thread.create({
        data: {
          userId: USER_ID,
          codexThreadId: 'cdx-late',
          mode: 'learn',
          topicSlug: null,
          title: 'test',
          sessionToken: 'tok-cdx-late',
        },
      });
      const first = shortManager.startTurn(thread, 'hangs past the fail-safe');
      const second = shortManager.startTurn(thread, 'queued behind it');
      await first; // settles via the 800ms fail-safe → turn.error

      // Wait for turn 2's turn/start, then deliver turn ONE's late completion.
      const deadline = Date.now() + 5_000;
      while (turnStarts.length < 2) {
        if (Date.now() > deadline) throw new Error('turn 2 never started');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      completeLate!();

      // The pre-fix bug: turn-late-1's completion settled turn 2's waiter.
      let secondSettled = false;
      void second.then(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(secondSettled).toBe(false);

      // Turn 2 settles only by its OWN completion.
      fake.notifyClient('turn/completed', {
        threadId: 'cdx-late',
        turn: { id: 'turn-late-2', status: 'completed', error: null },
      });
      await second;

      const errors = sink.records.filter(
        (r) => r.target === 'thread' && r.event.type === 'turn.error',
      );
      const completions = sink.records.filter(
        (r) => r.target === 'thread' && r.event.type === 'turn.completed',
      );
      expect(errors.length).toBe(1); // the fail-safe abort of turn 1
      expect((errors[0]!.event as Extract<WsEvent, { type: 'turn.error' }>).threadId).toBe(
        thread.id,
      );
      expect(completions.length).toBe(1); // turn 2 only
    } finally {
      shortManager.close();
    }
  });
});

describe('resumeAll', () => {
  it('re-resumes touched threads against the new child after a restart', async () => {
    scriptCannedTurns(fake, counters);
    const { thread } = await manager.ensureThread(USER_ID, 'learn');
    await sink.until((r) => r.event.type === 'turn.completed');

    fake.exitNow(1); // auto-restart spawns a second fake (backoff 10ms)
    const deadline = Date.now() + 5_000;
    while (spawns.length < 2 || !client.isRunning) {
      if (Date.now() > deadline) throw new Error('client never restarted');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const secondFake = spawns[1]!.child;
    await manager.resumeAll();
    const resume = secondFake.received.find((m) => m.method === 'thread/resume');
    expect(resume).toBeDefined();
    expect((resume!.params as { threadId: string }).threadId).toBe(thread.codexThreadId);
  });
});
