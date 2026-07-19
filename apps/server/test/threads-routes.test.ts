import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Thread } from '@prisma/client';
import {
  createThreadResponseSchema,
  listThreadsResponseSchema,
  threadItemsResponseSchema,
  type ThreadMode,
} from '@eduagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import type { EnsureThreadResult, ThreadService } from '../src/threads/index.js';
import { createTestDbUrl } from './helpers/test-db.js';

/**
 * Thread REST routes against the shared contract schemas (plans/03 §7):
 * zod-validated bodies, ownership checks, pagination, and exact response
 * shapes (parsed back through the same schemas the web client uses).
 */

class FakeThreadService implements ThreadService {
  constructor(private readonly prisma: PrismaClient) {}
  ensured: Array<{ userId: string; mode: string; topicSlug: string | null }> = [];
  interrupted: string[] = [];

  async ensureThread(
    userId: string,
    mode: ThreadMode,
    opts: { topicSlug?: string | null } = {},
  ): Promise<EnsureThreadResult> {
    const topicSlug = opts.topicSlug ?? null;
    this.ensured.push({ userId, mode, topicSlug });
    const existing = await this.prisma.thread.findFirst({
      where: { userId, mode, topicSlug, status: 'active' },
    });
    if (existing) return { thread: existing, created: false };
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: `cdx-${this.ensured.length}-${Date.now()}`,
        mode,
        topicSlug,
        title: topicSlug ? `Learning ${topicSlug}` : 'Getting to know you',
        sessionToken: `tok-${this.ensured.length}-${Date.now()}`,
      },
    });
    return { thread, created: true };
  }
  startTurn(): Promise<void> {
    return Promise.resolve();
  }
  startSystemTurn(): Promise<void> {
    return Promise.resolve();
  }
  interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
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

let app: FastifyInstance;
let prisma: PrismaClient;
let threads: FakeThreadService;
let cookie: string;
let userId: string;

async function login(handle: string): Promise<{ id: string; cookie: string }> {
  const res = await app.inject({ method: 'POST', url: '/auth/local-login', payload: { handle } });
  expect(res.statusCode).toBe(200);
  return {
    id: (res.json() as { id: string }).id,
    cookie: String(res.headers['set-cookie']).split(';')[0]!,
  };
}

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('threads-routes');
  prisma = createPrisma(databaseUrl);
  threads = new FakeThreadService(prisma);
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'threads-routes-test-secret',
    }),
    prisma,
    services: { threads },
  });
  await app.ready();
  const session = await login('routes-user');
  cookie = session.cookie;
  userId = session.id;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('POST /api/threads', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/threads', payload: { mode: 'learn' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates (ensures) a learn thread and returns the shared summary shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { mode: 'learn', topicSlug: 'sql' },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const summary = createThreadResponseSchema.parse(res.json());
    expect(summary.mode).toBe('learn');
    expect(summary.topicSlug).toBe('sql');
    expect(threads.ensured.at(-1)).toEqual({ userId, mode: 'learn', topicSlug: 'sql' });

    // Ensuring again returns the same thread.
    const again = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { mode: 'learn', topicSlug: 'sql' },
      headers: { cookie },
    });
    expect(createThreadResponseSchema.parse(again.json()).id).toBe(summary.id);
  });

  it('rejects invalid bodies and unsupported modes with 400', async () => {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { mode: 'nonsense' },
      headers: { cookie },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_body' });

    const exam = await app.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { mode: 'exam' },
      headers: { cookie },
    });
    expect(exam.statusCode).toBe(400);
    expect(exam.json()).toMatchObject({ error: 'unsupported_mode' });
  });
});

describe('GET /api/threads', () => {
  it('lists only the caller’s threads, filtered by mode', async () => {
    const other = await login('routes-other');
    await prisma.thread.create({
      data: {
        userId: other.id,
        codexThreadId: 'cdx-foreign',
        mode: 'learn',
        title: 'foreign',
        sessionToken: 'tok-foreign',
      },
    });

    const res = await app.inject({ method: 'GET', url: '/api/threads?mode=learn', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const { threads: list } = listThreadsResponseSchema.parse(res.json());
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((t) => t.mode === 'learn')).toBe(true);
    expect(list.some((t) => t.title === 'foreign')).toBe(false);

    const badMode = await app.inject({
      method: 'GET',
      url: '/api/threads?mode=bogus',
      headers: { cookie },
    });
    expect(badMode.statusCode).toBe(400);

    const own = await prisma.thread.findFirstOrThrow({ where: { userId, mode: 'learn' } });
    await prisma.thread.update({ where: { id: own.id }, data: { trackSlug: 'sql-interview' } });
    const byTrack = await app.inject({
      method: 'GET',
      url: '/api/threads?track=sql-interview',
      headers: { cookie },
    });
    const filtered = listThreadsResponseSchema.parse(byTrack.json()).threads;
    expect(filtered.map((thread) => thread.id)).toEqual([own.id]);
  });
});

describe('GET /api/threads/:id/items', () => {
  let thread: Thread;

  beforeAll(async () => {
    thread = (await threads.ensureThread(userId, 'learn', { topicSlug: 'items-topic' })).thread;
    // Deterministic createdAt ordering across the three rows.
    const base = Date.now() - 10_000;
    await prisma.itemMirror.create({
      data: {
        threadId: thread.id,
        role: 'user',
        kind: 'message',
        payload: { text: 'q1' },
        createdAt: new Date(base),
      },
    });
    await prisma.itemMirror.create({
      data: {
        id: 'msg_route_1',
        threadId: thread.id,
        codexItemId: 'msg_route_1',
        role: 'agent',
        kind: 'message',
        payload: { text: 'a1' },
        createdAt: new Date(base + 1_000),
      },
    });
    await prisma.itemMirror.create({
      data: {
        threadId: thread.id,
        role: 'agent',
        kind: 'exec',
        payload: { command: 'ls', exitCode: 0 },
        createdAt: new Date(base + 2_000),
      },
    });
  });

  it('returns ordered items in the shared shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/items`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { items } = threadItemsResponseSchema.parse(res.json());
    expect(items.map((i) => i.kind)).toEqual(['message', 'message', 'exec']);
    expect(items[0]!.payload).toEqual({ text: 'q1' });
    expect(items[1]!.id).toBe('msg_route_1');
    expect(items[1]!.codexItemId).toBe('msg_route_1');
  });

  it('paginates with take/skip', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/items?take=1&skip=1`,
      headers: { cookie },
    });
    const { items } = threadItemsResponseSchema.parse(res.json());
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('msg_route_1');

    const bad = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/items?take=0`,
      headers: { cookie },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('404s for missing and foreign threads alike', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/threads/nope/items',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);

    const intruder = await login('routes-intruder');
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/threads/${thread.id}/items`,
      headers: { cookie: intruder.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('POST /api/threads/:id/interrupt', () => {
  it('interrupts an owned thread and 404s a foreign one', async () => {
    const { thread } = await threads.ensureThread(userId, 'learn', { topicSlug: 'stop-me' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/interrupt`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(threads.interrupted).toContain(thread.id);

    const intruder = await login('routes-interruptor');
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/interrupt`,
      headers: { cookie: intruder.cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('without services', () => {
  it('503s thread creation until the backend finishes booting', async () => {
    const databaseUrl = createTestDbUrl('threads-noservices');
    const barePrisma = createPrisma(databaseUrl);
    const bare = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'local',
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'threads-routes-test-secret',
      }),
      prisma: barePrisma,
    });
    await bare.ready();
    const login = await bare.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'bare' },
    });
    const res = await bare.inject({
      method: 'POST',
      url: '/api/threads',
      payload: { mode: 'learn' },
      headers: { cookie: String(login.headers['set-cookie']).split(';')[0]! },
    });
    expect(res.statusCode).toBe(503);
    await bare.close();
    await barePrisma.$disconnect();
  });
});
