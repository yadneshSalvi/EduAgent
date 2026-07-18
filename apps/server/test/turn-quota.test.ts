import type { PrismaClient } from '@prisma/client';
import type { WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppServerClient } from '../src/codex/index.js';
import { createPrisma } from '../src/db.js';
import {
  DAILY_QUOTA_MESSAGE,
  DailyTurnQuotaError,
  ThreadManager,
  TURN_START_EVENT,
} from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { FakeAppServer, fakeSpawner, type WireMessage } from './helpers/fake-appserver.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * Daily USER-turn quota (plans/08 §5): ThreadManager refuses the N+1th user
 * turn of a local day with a terminal turn.error + DailyTurnQuotaError, while
 * system turns (greeting, grading) stay exempt and quota 0 disables all
 * bookkeeping.
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

const memoryStub = {
  beforeTurn: () => Promise.resolve('sha-before'),
  afterTurn: () => Promise.resolve([]),
};

/** Scripts a complete canned turn on any turn/start request. */
function scriptCannedTurns(fake: FakeAppServer, counters: { turn: number }) {
  fake.onMethod('turn/start', (msg: WireMessage) => {
    const { threadId } = msg.params as { threadId: string };
    counters.turn += 1;
    const turnId = `turn-${counters.turn}`;
    fake.respond(msg.id as number, { turn: { id: turnId, status: 'inProgress' } });
    fake.notifyClient('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
    fake.notifyClient('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: `msg-${turnId}`, text: 'ok', phase: 'final_answer' },
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
let workspaces: WorkspaceManager;
let cleanupDataDir: () => Promise<void>;
let fake: FakeAppServer;
let sink: ReturnType<typeof recordingSink>;
const counters = { thread: 0, turn: 0 };
const USER_ID = 'user-quota-1';

function buildManager(dailyTurnQuota: number): ThreadManager {
  return new ThreadManager({
    prisma,
    client,
    workspaces,
    memory: memoryStub,
    sink,
    dailyTurnQuota,
  });
}

beforeEach(async () => {
  prisma = createPrisma(createTestDbUrl('turn-quota'));
  await prisma.user.create({
    data: { id: USER_ID, handle: `quota-${Date.now()}`, displayName: 'Q', workspacePath: 'x' },
  });

  const dataDir = createTestDataDir();
  cleanupDataDir = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);

  const spawner = fakeSpawner((child) => {
    child.onMethod('thread/start', (msg) => {
      counters.thread += 1;
      child.respond(msg.id as number, { thread: { id: `cdx-q-${counters.thread}` } });
    });
    child.onMethod('thread/resume', (msg) => {
      child.respond(msg.id as number, {
        thread: { id: (msg.params as { threadId: string }).threadId },
      });
    });
  });
  client = new AppServerClient({
    codexBin: 'codex',
    defaultModel: 'gpt-test',
    spawnFn: spawner.spawnFn,
    backoff: { initialMs: 10, stableMs: 10_000 },
  });
  await client.start();
  fake = spawner.spawns[0]!.child;
  scriptCannedTurns(fake, counters);
  sink = recordingSink();
});

afterEach(async () => {
  await client.close();
  await prisma.$disconnect();
  await cleanupDataDir();
});

describe('daily turn quota', () => {
  it('refuses the quota+1th USER turn with a terminal turn.error and no side effects', async () => {
    const manager = buildManager(2);
    try {
      const { thread } = await manager.ensureThread(USER_ID, 'learn');

      await manager.startTurn(thread, 'turn one');
      await manager.startTurn(thread, 'turn two');
      const events = await prisma.activityEvent.findMany({
        where: { userId: USER_ID, kind: TURN_START_EVENT },
      });
      expect(events).toHaveLength(2);
      expect(events[0]!.meta).toMatchObject({ threadId: thread.id, mode: 'learn' });

      const mirrorsBefore = await prisma.itemMirror.count({ where: { threadId: thread.id } });
      await expect(manager.startTurn(thread, 'turn three')).rejects.toBeInstanceOf(
        DailyTurnQuotaError,
      );

      const refusal = sink.records.find(
        (r) => r.event.type === 'turn.error' && r.event.retryable === false,
      );
      expect(refusal).toBeDefined();
      expect(refusal!.event).toMatchObject({ message: DAILY_QUOTA_MESSAGE });
      // Refusals reach the user socket too (turn lifecycle contract).
      expect(
        sink.records.some(
          (r) => r.target === 'user' && r.event.type === 'turn.error' && !r.event.retryable,
        ),
      ).toBe(true);
      // No trace: no third start recorded, no mirrored user message.
      expect(
        await prisma.activityEvent.count({ where: { userId: USER_ID, kind: TURN_START_EVENT } }),
      ).toBe(2);
      expect(await prisma.itemMirror.count({ where: { threadId: thread.id } })).toBe(mirrorsBefore);
    } finally {
      manager.close();
    }
  });

  it('exempts system turns, even once the quota is exhausted', async () => {
    const manager = buildManager(1);
    try {
      // The auto-greeting on create is a system turn — it must not consume.
      const { thread } = await manager.ensureThread(USER_ID, 'learn');
      await manager.startTurn(thread, 'the single allowed user turn');
      await expect(manager.startTurn(thread, 'over quota')).rejects.toBeInstanceOf(
        DailyTurnQuotaError,
      );
      await expect(
        manager.startSystemTurn(thread, 'grading turn', { caption: 'Graded.' }),
      ).resolves.toBeUndefined();
      expect(
        await prisma.activityEvent.count({ where: { userId: USER_ID, kind: TURN_START_EVENT } }),
      ).toBe(1);
    } finally {
      manager.close();
    }
  });

  it("only counts starts from the user's current local day", async () => {
    // Yesterday's starts must not count against today (26h > any UTC offset).
    await prisma.activityEvent.create({
      data: {
        userId: USER_ID,
        kind: TURN_START_EVENT,
        meta: {},
        at: new Date(Date.now() - 27 * 3_600_000),
      },
    });
    const manager = buildManager(1);
    try {
      const { thread } = await manager.ensureThread(USER_ID, 'learn');
      await expect(
        manager.startTurn(thread, 'fresh day, fresh allowance'),
      ).resolves.toBeUndefined();
    } finally {
      manager.close();
    }
  });

  it('quota 0 (the default) never refuses and writes no bookkeeping events', async () => {
    const manager = buildManager(0);
    try {
      const { thread } = await manager.ensureThread(USER_ID, 'learn');
      await manager.startTurn(thread, 'one');
      await manager.startTurn(thread, 'two');
      expect(
        await prisma.activityEvent.count({ where: { userId: USER_ID, kind: TURN_START_EVENT } }),
      ).toBe(0);
    } finally {
      manager.close();
    }
  });
});
