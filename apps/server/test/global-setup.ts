import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { serverDir, templateDbPath, testDbDir } from './helpers/test-db.js';

// Workers fork after global-setup: publish this invocation's db dir so every
// test file resolves the SAME per-run dir (worker pids differ from ours).
process.env.VITEST_DB_DIR = testDbDir;

function prisma(args: string[], extraEnv: Record<string, string> = {}): void {
  try {
    execFileSync('pnpm', ['exec', 'prisma', ...args], {
      cwd: serverDir,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: Buffer; stderr?: Buffer };
    console.error(`prisma ${args.join(' ')} failed:`);
    if (stdout?.length) console.error(stdout.toString());
    if (stderr?.length) console.error(stderr.toString());
    throw err;
  }
}

export default function setup(): () => void {
  // Only this invocation's subdir — a concurrent vitest run (e.g. the gated
  // E2E) has its own, and deleting its open SQLite files would poison it.
  fs.rmSync(testDbDir, { recursive: true, force: true });
  fs.mkdirSync(testDbDir, { recursive: true });
  // Idempotent; keeps `pnpm test` green on a fresh clone without db:setup.
  prisma(['generate']);
  // migrate deploy (not db push) so tests also validate the committed migrations.
  prisma(['migrate', 'deploy'], { DATABASE_URL: `file:${templateDbPath}` });

  return function teardown(): void {
    fs.rmSync(testDbDir, { recursive: true, force: true });
  };
}
