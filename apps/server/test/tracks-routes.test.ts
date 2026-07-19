import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { TrackNotFoundError, TrackService, TrackStateError } from '../src/learning/index.js';
import { createTestDbUrl } from './helpers/test-db.js';

let app: FastifyInstance;
let prisma: PrismaClient;
let cookie: string;

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('tracks-routes');
  prisma = createPrisma(databaseUrl);
  const tracks = {
    list: () => Promise.resolve([]),
    detail: (_userId: string, slug: string) => Promise.reject(new TrackNotFoundError(slug)),
    generate: () => Promise.reject(new TrackStateError('Only failed tracks may retry.')),
    archive: () => Promise.reject(new TrackNotFoundError('missing')),
    sessions: () => Promise.reject(new TrackNotFoundError('missing')),
    create: () => Promise.reject(new Error('not reached')),
    completeDay: () => Promise.reject(new Error('not reached')),
    createSession: () => Promise.reject(new Error('not reached')),
  } as unknown as TrackService;
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'tracks-routes-test-secret',
    }),
    prisma,
    services: { tracks },
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/auth/local-login',
    payload: { handle: 'tracks-routes-user' },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe('track routes', () => {
  it('requires authentication and validates intake at the boundary', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tracks' })).statusCode).toBe(401);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/tracks',
      headers: { cookie },
      payload: { subject: '' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: 'invalid_body' });
  });

  it('maps ownership-safe not-found and invalid-state errors to shared envelopes', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/tracks/missing',
      headers: { cookie },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: 'not_found' });

    const retry = await app.inject({
      method: 'POST',
      url: '/api/tracks/sql-interview/generate',
      headers: { cookie },
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({ error: 'invalid_state' });
  });
});
