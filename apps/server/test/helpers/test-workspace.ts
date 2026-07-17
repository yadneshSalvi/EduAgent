import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { repoRoot } from './test-db.js';

/**
 * Hermetic config whose DATA_DIR is a throwaway dir under gitignored data/
 * (so workspace git repos and installed skills land nowhere real).
 */
export function createTestDataDir(): { config: AppConfig; cleanup: () => Promise<void> } {
  const dataDir = path.join(
    repoRoot,
    'data',
    `test-ws-${process.pid}-${randomBytes(4).toString('hex')}`,
  );
  const config = loadConfig({ DATA_DIR: dataDir });
  return {
    config,
    cleanup: () => fs.rm(dataDir, { recursive: true, force: true }),
  };
}
