import { PrismaClient } from '@prisma/client';

/**
 * Creates the Prisma client against an explicit SQLite URL (the schema's
 * env("DATABASE_URL") is only used by the CLI; runtime always passes the
 * config-derived URL so tests can point at throwaway files).
 */
export function createPrisma(databaseUrl: string): PrismaClient {
  return new PrismaClient({ datasourceUrl: databaseUrl });
}
