import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
export const serverDir = path.resolve(helpersDir, '..', '..');
export const repoRoot = path.resolve(serverDir, '..', '..');

/** Throwaway SQLite files live under gitignored data/; global-setup wipes the dir. */
export const testDbDir = path.join(repoRoot, 'data', 'test-dbs');
export const templateDbPath = path.join(testDbDir, 'template.db');

/**
 * Copies the migrated template db (built once in global-setup) to a fresh
 * per-test-file db and returns its Prisma URL.
 */
export function createTestDbUrl(name: string): string {
  const dbPath = path.join(
    testDbDir,
    `${name}-${process.pid}-${randomBytes(4).toString('hex')}.db`,
  );
  fs.copyFileSync(templateDbPath, dbPath);
  return `file:${dbPath}`;
}
