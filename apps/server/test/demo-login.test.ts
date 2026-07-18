import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { DemoClerkClient } from '../src/auth/index.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl } from './helpers/test-db.js';

/**
 * POST /auth/demo-login against a FAKE Clerk Backend API (plans/08 §5-6):
 * first use creates + links the Clerk user (race-safe), later uses only mint
 * sign-in tokens, Clerk failures map to 502. The access-code gates live in
 * auth-clerk.test.ts; one real-API mint happens at Phase 5 verification.
 */

const ACCESS_CODE = 'judge-code-42';
const CLERK_USER_ID = 'user_clerk_alex_1';

interface FakeCalls {
  findDemoUser: Array<{ handle: string }>;
  createDemoUser: Array<{ handle: string; displayName: string }>;
  createSignInToken: Array<{ userId: string; expiresInSeconds: number }>;
}

function fakeClerk(overrides: Partial<DemoClerkClient> = {}) {
  const calls: FakeCalls = { findDemoUser: [], createDemoUser: [], createSignInToken: [] };
  const client: DemoClerkClient = {
    async findDemoUser(params) {
      calls.findDemoUser.push(params);
      return null;
    },
    async createDemoUser(params) {
      calls.createDemoUser.push(params);
      return { id: CLERK_USER_ID };
    },
    async createSignInToken(params) {
      calls.createSignInToken.push(params);
      return {
        token: `tok-${params.userId}-${calls.createSignInToken.length}`,
        userId: params.userId,
      };
    },
    ...overrides,
  };
  return { calls, client };
}

let app: FastifyInstance;
let prisma: PrismaClient;

async function buildDemoApp(demoClerk: DemoClerkClient): Promise<void> {
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'clerk',
    DATABASE_URL: createTestDbUrl('demo-login'),
    CLERK_SECRET_KEY: 'sk_test_fake_key_for_tests',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
    ACCESS_CODE,
  });
  prisma = createPrisma(config.databaseUrl);
  app = await buildApp({ config, prisma, demoClerk });
  await app.ready();
  await prisma.user.create({
    data: { id: 'alex', handle: 'alex', displayName: 'Alex', workspacePath: 'x' },
  });
}

afterEach(async () => {
  await app.close();
  await prisma.$disconnect();
});

const login = (accessCode = ACCESS_CODE) =>
  app.inject({ method: 'POST', url: '/auth/demo-login', payload: { accessCode } });

describe('POST /auth/demo-login (fake Clerk)', () => {
  it('first use creates the Clerk user, links authId, and returns token + userId', async () => {
    const { calls, client } = fakeClerk();
    await buildDemoApp(client);

    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ token: `tok-${CLERK_USER_ID}-1`, userId: CLERK_USER_ID });

    expect(calls.createDemoUser).toEqual([{ handle: 'alex', displayName: 'Alex' }]);
    expect(calls.createSignInToken).toEqual([{ userId: CLERK_USER_ID, expiresInSeconds: 600 }]);
    const alex = await prisma.user.findUniqueOrThrow({ where: { handle: 'alex' } });
    expect(alex.authId).toBe(CLERK_USER_ID);
  });

  it('later uses skip user creation and just mint a fresh token', async () => {
    const { calls, client } = fakeClerk();
    await buildDemoApp(client);
    await prisma.user.update({ where: { handle: 'alex' }, data: { authId: CLERK_USER_ID } });

    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(calls.createDemoUser).toHaveLength(0);
    expect(calls.createSignInToken).toEqual([{ userId: CLERK_USER_ID, expiresInSeconds: 600 }]);
  });

  it('concurrent first uses create exactly ONE Clerk user', async () => {
    const { calls, client } = fakeClerk();
    await buildDemoApp(client);

    const results = await Promise.all([login(), login(), login()]);
    for (const res of results) {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ userId: CLERK_USER_ID });
    }
    expect(calls.createDemoUser).toHaveLength(1);
    const alex = await prisma.user.findUniqueOrThrow({ where: { handle: 'alex' } });
    expect(alex.authId).toBe(CLERK_USER_ID);
  });

  it('relinks a fresh DB to an EXISTING Clerk demo user instead of creating a duplicate', async () => {
    // Post-reseed scenario: alex.authId is null but the standing Clerk user
    // exists — the unique demo email makes a second createUser fail forever.
    const { calls, client } = fakeClerk({
      findDemoUser: async (params) => {
        calls.findDemoUser.push(params);
        return { id: CLERK_USER_ID };
      },
    });
    await buildDemoApp(client);

    const res = await login();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ userId: CLERK_USER_ID });
    expect(calls.findDemoUser).toEqual([{ handle: 'alex' }]);
    expect(calls.createDemoUser).toHaveLength(0);
    const alex = await prisma.user.findUniqueOrThrow({ where: { handle: 'alex' } });
    expect(alex.authId).toBe(CLERK_USER_ID);
  });

  it('404s no_demo_user when the seeded row is missing', async () => {
    const { client } = fakeClerk();
    await buildDemoApp(client);
    await prisma.user.delete({ where: { handle: 'alex' } });

    const res = await login();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: 'no_demo_user' });
  });

  it('maps Clerk API failures to 502 without linking anything', async () => {
    const { calls, client } = fakeClerk({
      createDemoUser: () => Promise.reject(new Error('clerk 500')),
    });
    await buildDemoApp(client);

    const res = await login();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'clerk_unavailable' });
    expect(calls.createSignInToken).toHaveLength(0);
    const alex = await prisma.user.findUniqueOrThrow({ where: { handle: 'alex' } });
    expect(alex.authId).toBeNull();
  });

  it('maps token-mint failures to 502 (link may already exist)', async () => {
    const { client } = fakeClerk({
      createSignInToken: () => Promise.reject(new Error('clerk down')),
    });
    await buildDemoApp(client);
    await prisma.user.update({ where: { handle: 'alex' }, data: { authId: CLERK_USER_ID } });

    const res = await login();
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: 'clerk_unavailable' });
  });

  it('still 403s a wrong access code before touching Clerk', async () => {
    const { calls, client } = fakeClerk();
    await buildDemoApp(client);

    const res = await login('wrong-code');
    expect(res.statusCode).toBe(403);
    expect(calls.createDemoUser).toHaveLength(0);
    expect(calls.createSignInToken).toHaveLength(0);
  });
});
