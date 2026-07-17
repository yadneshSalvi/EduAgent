import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helpersDir = path.dirname(fileURLToPath(import.meta.url));
export const serverDir = path.resolve(helpersDir, '..', '..');
export const repoRoot = path.resolve(serverDir, '..', '..');

/**
 * Throwaway SQLite files live under gitignored data/, in a PER-INVOCATION
 * subdir (keyed by the vitest pid via VITEST_DB_DIR from global-setup, falling
 * back to this process). Concurrent vitest runs — e.g. unit tests while the
 * gated E2E is in flight — must never wipe each other's live databases:
 * SQLite reports SQLITE_READONLY_DBMOVED on every write after the file is
 * deleted under an open connection (observed in the Phase 1 review).
 */
export const testDbRootDir = path.join(repoRoot, 'data', 'test-dbs');
export const testDbDir =
  process.env.VITEST_DB_DIR ?? path.join(testDbRootDir, `run-${process.pid}`);
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
