import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl, testDbDir } from './helpers/test-db.js';

const opened: Array<{ app: FastifyInstance; prisma: PrismaClient }> = [];

async function appFor(databaseUrl: string): Promise<FastifyInstance> {
  const prisma = createPrisma(databaseUrl);
  const config = loadConfig({ NODE_ENV: 'test', AUTH_MODE: 'local', DATABASE_URL: databaseUrl });
  const app = await buildApp({ config, prisma });
  await app.ready();
  opened.push({ app, prisma });
  return app;
}

afterAll(async () => {
  for (const { app, prisma } of opened) {
    await app.close();
    await prisma.$disconnect();
  }
});

describe('GET /healthz', () => {
  it('returns 200 with db ok on a migrated database', async () => {
    const app = await appFor(createTestDbUrl('healthz'));
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { db: 'ok' } });
  });

  it('returns 503 when the database has no schema (db:setup never ran)', async () => {
    const emptyDb = path.join(testDbDir, `healthz-empty-${process.pid}.db`);
    fs.writeFileSync(emptyDb, '');
    const app = await appFor(`file:${emptyDb}`);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
  });
});
