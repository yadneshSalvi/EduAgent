import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient, Thread } from '@prisma/client';
import type { ThreadMode } from '@eduagent/shared';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WsGateway } from '../src/api/gateway.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import type { EnsureThreadResult, ThreadService } from '../src/threads/index.js';
import { createTestDbUrl } from './helpers/test-db.js';

/**
 * WS gateway behavior against fake thread services (no codex): auth (4401),
 * thread ownership (4403), ping/pong, user.message dispatch, reconnect
 * snapshots, and user-socket fan-out (plans/03 §7).
 */

class FakeThreadService implements ThreadService {
  started: Array<{ threadId: string; text: string }> = [];
  interrupted: string[] = [];
  inFlight = new Map<string, string>(); // threadId → userId
  failNextStart: Error | null = null;

  ensureThread(): Promise<EnsureThreadResult> {
    return Promise.reject(new Error('not used in this test'));
  }
  startTurn(thread: Thread, text: string): Promise<void> {
    if (this.failNextStart) {
      const err = this.failNextStart;
      this.failNextStart = null;
      return Promise.reject(err);
    }
    this.started.push({ threadId: thread.id, text });
    return Promise.resolve();
  }
  startSystemTurn(thread: Thread, text: string): Promise<void> {
    return this.startTurn(thread, text);
  }
  interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
    return Promise.resolve();
  }
  turnInFlight(threadId: string): boolean {
    return this.inFlight.has(threadId);
  }
  inFlightThreads(userId: string): string[] {
    return [...this.inFlight.entries()].filter(([, uid]) => uid === userId).map(([tid]) => tid);
  }
  resumeAll(): Promise<void> {
    return Promise.resolve();
  }
}

let app: FastifyInstance;
let prisma: PrismaClient;
let gateway: WsGateway;
let threads: FakeThreadService;
let baseUrl: string;
let userId: string;
let cookie: string;
let thread: Thread;

async function login(handle: string): Promise<{ id: string; cookie: string }> {
  const res = await app.inject({ method: 'POST', url: '/auth/local-login', payload: { handle } });
  expect(res.statusCode).toBe(200);
  const pair = String(res.headers['set-cookie']).split(';')[0]!;
  return { id: (res.json() as { id: string }).id, cookie: pair };
}

function connect(path: string, withCookie = true): WebSocket {
  return new WebSocket(`${baseUrl}${path}`, {
    headers: withCookie ? { cookie } : {},
  });
}

function nextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(String(data)));
    socket.once('error', reject);
    socket.once('close', (code) => reject(new Error(`closed ${code}`)));
  });
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function closedWith(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('ws-gateway');
  prisma = createPrisma(databaseUrl);
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'local',
    DATABASE_URL: databaseUrl,
    SESSION_SECRET: 'ws-gateway-test-secret',
  });
  gateway = new WsGateway();
  threads = new FakeThreadService();
  app = await buildApp({ config, prisma, services: { threads, gateway } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const session = await login('ws-owner');
  userId = session.id;
  cookie = session.cookie;
  thread = await prisma.thread.create({
    data: {
      userId,
      codexThreadId: 'cdx-ws-1',
      mode: 'learn' satisfies ThreadMode,
      title: 'ws test',
      sessionToken: 'tok-ws-1',
    },
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('GET /ws?threadId=', () => {
  it('closes 4401 without a session', async () => {
    const socket = connect(`/ws?threadId=${thread.id}`, false);
    expect(await closedWith(socket)).toBe(4401);
  });

  it('closes 4400 without a threadId', async () => {
    const socket = connect('/ws');
    expect(await closedWith(socket)).toBe(4400);
  });

  it("closes 4403 for another user's thread (and unknown ids)", async () => {
    const other = await login('ws-intruder');
    const socket = new WebSocket(`${baseUrl}/ws?threadId=${thread.id}`, {
      headers: { cookie: other.cookie },
    });
    expect(await closedWith(socket)).toBe(4403);

    const ghost = connect('/ws?threadId=no-such-thread');
    expect(await closedWith(ghost)).toBe(4403);
  });

  it('answers ping (JSON and legacy text) and dispatches user.message', async () => {
    const socket = connect(`/ws?threadId=${thread.id}`);
    await opened(socket);

    socket.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(await nextMessage(socket))).toEqual({ type: 'pong' });
    socket.send('ping');
    expect(await nextMessage(socket)).toBe('pong');

    socket.send(JSON.stringify({ type: 'user.message', text: 'hello tutor' }));
    const deadline = Date.now() + 2_000;
    while (threads.started.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(threads.started).toEqual([{ threadId: thread.id, text: 'hello tutor' }]);
    socket.close();
  });

  it('buffers frames sent before auth settles (no lost first message)', async () => {
    const socket = connect(`/ws?threadId=${thread.id}`);
    // Send the instant the TCP/WS handshake completes — resolveUser has not.
    await opened(socket);
    socket.send(JSON.stringify({ type: 'user.message', text: 'eager message' }));
    const deadline = Date.now() + 2_000;
    while (!threads.started.some((s) => s.text === 'eager message') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(threads.started.some((s) => s.text === 'eager message')).toBe(true);
    socket.close();
  });

  it('sends a turn.started snapshot when a turn is in flight, and streams gateway events', async () => {
    threads.inFlight.set(thread.id, userId);
    const socket = connect(`/ws?threadId=${thread.id}`);
    expect(JSON.parse(await nextMessage(socket))).toEqual({
      type: 'turn.started',
      threadId: thread.id,
    });

    gateway.emitToThread(thread.id, { type: 'message.delta', itemId: 'i1', text: 'to' });
    expect(JSON.parse(await nextMessage(socket))).toEqual({
      type: 'message.delta',
      itemId: 'i1',
      text: 'to',
    });
    threads.inFlight.clear();
    socket.close();
  });

  it('emits a retryable turn.error when startTurn rejects', async () => {
    const socket = connect(`/ws?threadId=${thread.id}`);
    await opened(socket);
    threads.failNextStart = new Error('codex app-server is not ready');
    socket.send(JSON.stringify({ type: 'user.message', text: 'doomed' }));
    const frame = JSON.parse(await nextMessage(socket)) as { type: string; retryable?: boolean };
    expect(frame.type).toBe('turn.error');
    expect(frame.retryable).toBe(true);
    socket.close();
  });
});

describe('GET /ws/user', () => {
  it('closes 4401 without a session', async () => {
    const socket = connect('/ws/user', false);
    expect(await closedWith(socket)).toBe(4401);
  });

  it('receives user-level events and in-flight snapshots', async () => {
    threads.inFlight.set(thread.id, userId);
    const socket = connect('/ws/user');
    expect(JSON.parse(await nextMessage(socket))).toEqual({
      type: 'turn.started',
      threadId: thread.id,
    });

    gateway.emitToUser(userId, { type: 'turn.completed', threadId: thread.id });
    expect(JSON.parse(await nextMessage(socket))).toEqual({
      type: 'turn.completed',
      threadId: thread.id,
    });

    socket.send(JSON.stringify({ type: 'ping' }));
    expect(JSON.parse(await nextMessage(socket))).toEqual({ type: 'pong' });
    threads.inFlight.clear();
    socket.close();
  });

  it('does not deliver another user’s events', async () => {
    const socket = connect('/ws/user');
    await opened(socket);
    const received: string[] = [];
    socket.on('message', (data) => received.push(String(data)));
    gateway.emitToUser('someone-else', { type: 'turn.completed', threadId: 'x' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([]);
    socket.close();
  });
});

describe('without services (Phase 0-style boot)', () => {
  it('closes 1013 so clients back off instead of erroring', async () => {
    const databaseUrl = createTestDbUrl('ws-noservices');
    const barePrisma = createPrisma(databaseUrl);
    const bare = await buildApp({
      config: loadConfig({
        NODE_ENV: 'test',
        AUTH_MODE: 'local',
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'ws-gateway-test-secret',
      }),
      prisma: barePrisma,
    });
    await bare.listen({ port: 0, host: '127.0.0.1' });
    const port = (bare.server.address() as AddressInfo).port;
    const login = await bare.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'bare' },
    });
    const barePair = String(login.headers['set-cookie']).split(';')[0]!;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/user`, {
      headers: { cookie: barePair },
    });
    expect(await closedWith(socket)).toBe(1013);
    await bare.close();
    await barePrisma.$disconnect();
  });
});
