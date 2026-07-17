// Runs `next dev|start` on WEB_PORT (default 3000) so the port ALWAYS matches
// what the agent host computes CORS origins from (apps/server/src/config.ts
// reads WEB_PORT out of the repo-root .env). Shell env wins over .env — same
// precedence as the server. See apps/web/README.md.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadRootEnv } from 'dotenv';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadRootEnv({ path: path.resolve(appDir, '../../.env'), quiet: true });

const command = process.argv[2];
if (command !== 'dev' && command !== 'start') {
  console.error('usage: node scripts/next-with-port.mjs <dev|start>');
  process.exit(1);
}

const port = process.env.WEB_PORT ?? '3000';
const child = spawn('next', [command, '--port', port], {
  stdio: 'inherit',
  cwd: appDir,
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 0));
