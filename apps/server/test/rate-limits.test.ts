import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl } from './helpers/test-db.js';

/**
 * RATE_LIMITS=1 registers @fastify/rate-limit (plans/08 §5): a global per-IP
 * bucket, a tight 10/min bucket on the credential routes, and an exempt
 * /healthz. Default (unset) leaves the app entirely limiter-free.
 */

let app: FastifyInstance;
let prisma: PrismaClient;

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('rate-limits');
  prisma = createPrisma(databaseUrl);
  const config = loadConfig({
    NODE_ENV: 'test',
    AUTH_MODE: 'local',
    DATABASE_URL: databaseUrl,
    RATE_LIMITS: '1',
  });
  app = await buildApp({ config, prisma });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('RATE_LIMITS=1', () => {
  it('429s the 11th hit on a credential route within a minute', async () => {
    // demo-login 404s in local mode, but the bucket charges every attempt.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/demo-login',
        payload: { accessCode: 'x' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(404));
    expect(statuses[10]).toBe(429);
  });

  it('keeps the global bucket on ordinary routes (headers present, 300/min)', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/local-users' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('300');
  });

  it('never throttles /healthz', async () => {
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});

describe('RATE_LIMITS unset (default)', () => {
  it('registers no limiter at all', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: createTestDbUrl('rate-limits-off'),
    });
    const unlimited = await buildApp({ config, prisma });
    await unlimited.ready();
    try {
      for (let i = 0; i < 12; i++) {
        const res = await unlimited.inject({
          method: 'POST',
          url: '/auth/demo-login',
          payload: { accessCode: 'x' },
        });
        expect(res.statusCode).toBe(404);
        expect(res.headers['x-ratelimit-limit']).toBeUndefined();
      }
    } finally {
      await unlimited.close();
    }
  });
});
