import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Thread } from '@prisma/client';
import {
  reviewQueueResponseSchema,
  startReviewResponseSchema,
  type SrsQueueFile,
  type ThreadMode,
} from '@eduagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { dueSummary, nextDueProjection, ReviewService } from '../src/learning/index.js';
import { REVIEW_KICKOFF_INPUT } from '../src/prompts/index.js';
import type { EnsureThreadResult, ThreadService } from '../src/threads/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';
import { seedFixtureWorkspace } from './helpers/fixture-workspace.js';

/**
 * SrsEngine derivations + the review endpoints (plans/03 §3.5, §7) against
 * the fixture workspace seeded at the REAL clock, so its 3 due items are
 * genuinely due today. Thread mechanics ride a fake ThreadService — the live
 * review loop is the Phase 3 E2E's job.
 */

// ---------------------------------------------------------------- SrsEngine

describe('SrsEngine.dueSummary', () => {
  const queue: SrsQueueFile = {
    items: [
      { concept: 'b-due-today', topic: 'sql', due: '2026-07-16', interval_days: 3, ease: 2.5, lapses: 0 },
      { concept: 'a-due-today', topic: 'sql', due: '2026-07-16', interval_days: 3, ease: 2.5, lapses: 0 },
      { concept: 'overdue-one', topic: 'sql', due: '2026-07-10', interval_days: 7, ease: 2.5, lapses: 1 },
      { concept: 'future-one', topic: 'sql', due: '2026-07-20', interval_days: 5, ease: 2.5, lapses: 0 },
    ],
  };

  it('splits due/overdue/upcoming around today, sorted by due then concept', () => {
    const summary = dueSummary(queue, '2026-07-16');
    expect(summary.dueToday).toBe(2);
    expect(summary.overdue).toBe(1);
    expect(summary.due.map((i) => i.concept)).toEqual(['overdue-one', 'a-due-today', 'b-due-today']);
    expect(summary.upcoming.map((i) => i.concept)).toEqual(['future-one']);
  });

  it('empty queue → zeros', () => {
    expect(dueSummary({ items: [] }, '2026-07-16')).toEqual({
      dueToday: 0,
      overdue: 0,
      due: [],
      upcoming: [],
    });
  });
});

describe('SrsEngine.nextDueProjection', () => {
  it('projects both SM-2 branches from today', () => {
    const item = {
      concept: 'inner-join',
      topic: 'sql',
      due: '2026-07-16',
      interval_days: 3,
      ease: 2.5,
      lapses: 0,
    };
    // pass: round(3·2.5)=8 days; fail: 1 day.
    expect(nextDueProjection(item, '2026-07-16')).toEqual({
      ifPassed: '2026-07-24',
      ifFailed: '2026-07-17',
    });
  });
});

// ----------------------------------------------------------- review routes

class FakeThreadService implements ThreadService {
  constructor(private readonly prisma: PrismaClient) {}
  ensured: Array<{ userId: string; mode: ThreadMode }> = [];
  systemTurns: Array<{ threadId: string; text: string; caption?: string }> = [];
  inFlight = new Set<string>();

  async ensureThread(userId: string, mode: ThreadMode): Promise<EnsureThreadResult> {
    this.ensured.push({ userId, mode });
    const existing = await this.prisma.thread.findFirst({
      where: { userId, mode, topicSlug: null, status: 'active' },
    });
    if (existing) return { thread: existing, created: false };
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: `cdx-review-${this.ensured.length}-${Date.now()}`,
        mode,
        title: 'Review session',
        sessionToken: `tok-review-${this.ensured.length}-${Date.now()}`,
      },
    });
    return { thread, created: true };
  }
  startTurn(): Promise<void> {
    return Promise.resolve();
  }
  startSystemTurn(thread: Thread, text: string, opts?: { caption?: string }): Promise<void> {
    this.systemTurns.push({
      threadId: thread.id,
      text,
      ...(opts?.caption !== undefined ? { caption: opts.caption } : {}),
    });
    return Promise.resolve();
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  turnInFlight(threadId: string): boolean {
    return this.inFlight.has(threadId);
  }
  inFlightThreads(): string[] {
    return [];
  }
  resumeAll(): Promise<void> {
    return Promise.resolve();
  }
}

let app: FastifyInstance;
let prisma: PrismaClient;
let cleanup: () => Promise<void>;
let threads: FakeThreadService;
let cookie: string;
let userId: string;

async function login(handle: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/auth/local-login', payload: { handle } });
  expect(res.statusCode).toBe(200);
  return String(res.headers['set-cookie']).split(';')[0]!;
}

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('review-routes');
  prisma = createPrisma(databaseUrl);
  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  const workspaces = new WorkspaceManager(dataDir.config);
  threads = new FakeThreadService(prisma);
  const review = new ReviewService({ prisma, workspaces, threads });
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'review-routes-test-secret',
    }),
    prisma,
    services: { workspaces, threads, review },
  });
  await app.ready();

  cookie = await login('review-user');
  const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } });
  userId = (me.json() as { id: string }).id;
  // Real clock: the fixture's iso(0)/iso(2) items are due/overdue right now.
  await seedFixtureWorkspace(workspaces.pathFor(userId), new Date());
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await cleanup();
});

describe('GET /api/review/queue', () => {
  it('requires auth', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/review/queue' })).statusCode).toBe(401);
  });

  it('returns the due summary in the shared shape', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/review/queue', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = reviewQueueResponseSchema.parse(res.json());
    expect(body.dueToday).toBe(2);
    expect(body.overdue).toBe(1);
    expect(body.items.map((i) => i.concept)).toEqual([
      'select-basics',
      'inner-join',
      'where-clause',
    ]);
    expect(body.items[0]!.topic).toBe('sql');
  });

  it('a user without a workspace has an empty queue', async () => {
    const other = await login('review-empty');
    const res = await app.inject({
      method: 'GET',
      url: '/api/review/queue',
      headers: { cookie: other },
    });
    expect(reviewQueueResponseSchema.parse(res.json())).toEqual({
      dueToday: 0,
      overdue: 0,
      items: [],
    });
  });
});

describe('POST /api/review/start', () => {
  it('creates the review thread on first start (greeting turn owns kickoff)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/review/start', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { threadId } = startReviewResponseSchema.parse(res.json());
    const thread = await prisma.thread.findUnique({ where: { id: threadId } });
    expect(thread?.mode).toBe('review');
    expect(thread?.userId).toBe(userId);
    expect(threads.ensured.at(-1)).toEqual({ userId, mode: 'review' });
    // Freshly created → ThreadManager's auto-greeting runs; no extra kickoff.
    expect(threads.systemTurns).toEqual([]);
  });

  it('reuses the thread and kicks a captioned system turn when idle', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/review/start', headers: { cookie } });
    const { threadId } = startReviewResponseSchema.parse(res.json());
    // Fire-and-forget: give the microtask a beat.
    await new Promise((resolve) => setImmediate(resolve));
    expect(threads.systemTurns).toHaveLength(1);
    expect(threads.systemTurns[0]).toEqual({
      threadId,
      text: REVIEW_KICKOFF_INPUT,
      caption: 'Review session started.',
    });
  });

  it('does not kick when a turn is already in flight', async () => {
    const existing = await prisma.thread.findFirst({ where: { userId, mode: 'review' } });
    threads.inFlight.add(existing!.id);
    const res = await app.inject({ method: 'POST', url: '/api/review/start', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(threads.systemTurns).toHaveLength(1); // unchanged
    threads.inFlight.clear();
  });

  it('409s when nothing is due', async () => {
    const other = await login('review-nothing-due');
    const res = await app.inject({
      method: 'POST',
      url: '/api/review/start',
      headers: { cookie: other },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('nothing_due');
  });
});
