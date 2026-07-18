import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createAuthProvider } from '../src/auth/index.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl } from './helpers/test-db.js';

// No live Clerk sign-in here: all tokens are structurally invalid, so
// verifyToken fails at decode without any network I/O. Verifying a REAL
// Clerk JWT end-to-end happens at review time (per the Phase 0 task spec).

let app: FastifyInstance;
let prisma: PrismaClient;

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('auth-clerk');
  prisma = createPrisma(databaseUrl);
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'clerk',
    DATABASE_URL: databaseUrl,
    CLERK_SECRET_KEY: 'sk_test_fake_key_for_tests',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
    ACCESS_CODE: 'open-sesame',
  });
  app = await buildApp({ config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('AUTH_MODE=clerk auth', () => {
  it('rejects /auth/me with no credentials', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthenticated' });
  });

  it('rejects garbage bearer tokens', async () => {
    for (const token of ['garbage', 'aaa.bbb.ccc']) {
      const res = await app.inject({
        method: 'GET',
        url: '/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('rejects a garbage __session cookie', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { cookie: '__session=not-a-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('404s /auth/local-login in clerk mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'judge' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses provider construction without CLERK_SECRET_KEY', () => {
    const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'clerk' });
    expect(() => createAuthProvider(config, prisma)).toThrow(/CLERK_SECRET_KEY/);
  });
});

describe('POST /auth/demo-login (stub until Phase 5)', () => {
  it('rejects a wrong access code with 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/demo-login',
      payload: { accessCode: 'wrong' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('answers 501 for the correct access code, pointing at Phase 5', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/demo-login',
      payload: { accessCode: 'open-sesame' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json()).toMatchObject({ error: 'not_implemented' });
    expect(JSON.stringify(res.json())).toContain('Phase 5');
  });

  it('rejects a missing body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/demo-login', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('fails closed with 503 when ACCESS_CODE is unset (plans/08 §5)', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'clerk',
      DATABASE_URL: createTestDbUrl('auth-clerk-no-code'),
      CLERK_SECRET_KEY: 'sk_test_fake_key_for_tests',
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
      // ACCESS_CODE deliberately absent.
    });
    const ungated = await buildApp({ config, prisma });
    await ungated.ready();
    try {
      const res = await ungated.inject({
        method: 'POST',
        url: '/auth/demo-login',
        payload: { accessCode: 'anything' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ error: 'demo_login_disabled' });
    } finally {
      await ungated.close();
    }
  });
});

describe('WS /ws (clerk mode)', () => {
  it('closes unauthenticated connections with 4401', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { authorization: 'Bearer garbage' },
    });
    const code = await new Promise<number>((resolve) => {
      socket.once('close', (closeCode) => resolve(closeCode));
    });
    expect(code).toBe(4401);
  });
});
