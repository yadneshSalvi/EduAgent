import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { meResponseSchema } from '@eduagent/shared';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WsGateway } from '../src/api/gateway.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import type { ThreadService } from '../src/threads/index.js';
import { createTestDbUrl } from './helpers/test-db.js';

/** Auth tests only exercise connectivity; thread behavior lives in ws-gateway.test.ts. */
const idleThreads: ThreadService = {
  ensureThread: () => Promise.reject(new Error('not used')),
  startTurn: () => Promise.resolve(),
  interrupt: () => Promise.resolve(),
  turnInFlight: () => false,
  inFlightThreads: () => [],
  resumeAll: () => Promise.resolve(),
};

let app: FastifyInstance;
let prisma: PrismaClient;

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('auth-local');
  prisma = createPrisma(databaseUrl);
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'local',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'local-test-session-secret',
  });
  app = await buildApp({
    config,
    prisma,
    services: { threads: idleThreads, gateway: new WsGateway() },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

/** The `name=value` pair from Set-Cookie, verbatim (value stays URL-encoded). */
function sessionCookiePair(setCookie: string | string[] | undefined): string {
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(header).toBeDefined();
  const pair = header?.split(';')[0];
  expect(pair).toMatch(/^eduagent_session=/);
  return pair as string;
}

describe('AUTH_MODE=local auth flow', () => {
  it('rejects /auth/me without a session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('logs in (create-or-login), sets an httpOnly signed cookie, and resolves /auth/me', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'judge' },
    });
    expect(login.statusCode).toBe(200);
    const profile = meResponseSchema.parse(login.json());
    expect(profile.handle).toBe('judge');
    expect(profile.onboarded).toBe(false);

    const setCookie = login.headers['set-cookie'];
    const pair = sessionCookiePair(setCookie);
    expect(String(setCookie)).toContain('HttpOnly');

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: pair } });
    expect(me.statusCode).toBe(200);
    expect(meResponseSchema.parse(me.json()).id).toBe(profile.id);

    // Same handle logs into the same user, not a duplicate.
    const again = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'judge' },
    });
    expect(again.statusCode).toBe(200);
    expect(meResponseSchema.parse(again.json()).id).toBe(profile.id);
  });

  it('rejects a tampered (unsigned) cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'tamper' },
    });
    const userId = meResponseSchema.parse(login.json()).id;
    const forged = `eduagent_session=${encodeURIComponent(`${userId}.invalid-signature`)}`;
    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: forged } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid handle with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'Not A Handle!' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('404s /auth/demo-login in local mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/demo-login',
      payload: { accessCode: 'whatever' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('WS auth (local mode)', () => {
  let baseWsUrl: string | null = null;
  async function wsUrl(path: string): Promise<string> {
    if (baseWsUrl === null) {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as AddressInfo;
      baseWsUrl = `ws://127.0.0.1:${port}`;
    }
    return `${baseWsUrl}${path}`;
  }

  it('authenticates /ws/user via the session cookie and echoes ping→pong (text and JSON)', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'ws-judge' },
    });
    const pair = sessionCookiePair(login.headers['set-cookie']);

    const socket = new WebSocket(await wsUrl('/ws/user'), { headers: { cookie: pair } });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });

    const nextMessage = (): Promise<string> =>
      new Promise((resolve, reject) => {
        socket.once('message', (data) => resolve(String(data)));
        socket.once('error', reject);
      });

    socket.send('ping');
    expect(await nextMessage()).toBe('pong');

    socket.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(await nextMessage())).toEqual({ type: 'pong' });

    socket.close();
  });

  it('closes unauthenticated connections with 4401 (thread and user sockets)', async () => {
    for (const path of ['/ws?threadId=any', '/ws/user']) {
      const socket = new WebSocket(await wsUrl(path));
      const code = await new Promise<number>((resolve) => {
        socket.once('close', (closeCode) => resolve(closeCode));
      });
      expect(code).toBe(4401);
    }
  });
});
