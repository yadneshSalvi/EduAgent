/**
 * Runs the Prisma CLI with DATABASE_URL derived from the app config
 * (repo-root .env → DATA_DIR → file:<dataDir>/eduagent.db), so `pnpm
 * db:setup` needs no manually exported env vars. An explicit DATABASE_URL in
 * the environment wins. Usage: tsx scripts/prisma-env.ts <prisma args…>
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true });

try {
  execFileSync('pnpm', ['exec', 'prisma', ...process.argv.slice(2)], {
    cwd: serverDir,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? config.databaseUrl },
  });
} catch {
  // Prisma already printed its error via stdio: 'inherit'.
  process.exit(1);
}
