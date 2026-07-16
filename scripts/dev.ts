/**
 * Dev orchestrator: runs the web app and the agent host concurrently.
 *
 * Until the real apps land (Phase 0 tasks 2–3), their `dev` scripts are
 * placeholders that print a notice and exit 0 — so `pnpm dev` always
 * succeeds and shows what it will eventually run.
 */
import { spawn, type ChildProcess } from 'node:child_process';

interface Service {
  name: string;
  filter: string;
  hint: string;
}

const services: Service[] = [
  {
    name: 'web',
    filter: '@eduagent/web',
    hint: 'Next.js app — http://localhost:3000',
  },
  {
    name: 'server',
    filter: '@eduagent/server',
    hint: 'Agent host (Fastify) — http://localhost:8787, spawns codex app-server',
  },
];

console.log('EduAgent dev orchestrator\n');
console.log('Running these workspace dev servers concurrently:');
for (const s of services) {
  console.log(`  - ${s.name}: pnpm --filter ${s.filter} dev   (${s.hint})`);
}
console.log('');

const children: ChildProcess[] = [];
let remaining = services.length;
let exitCode = 0;
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill(signal);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const s of services) {
  const child = spawn('pnpm', ['--filter', s.filter, 'run', '--if-present', 'dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  children.push(child);

  const forward = (write: (line: string) => void) => (data: Buffer) => {
    for (const line of data.toString().split('\n')) {
      if (line.trim() !== '') write(`[${s.name}] ${line}`);
    }
  };
  child.stdout?.on(
    'data',
    forward((l) => console.log(l)),
  );
  child.stderr?.on(
    'data',
    forward((l) => console.error(l)),
  );

  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      exitCode = code;
      console.error(`[${s.name}] exited with code ${code} — stopping other services`);
      shutdown('SIGTERM');
    }
    remaining -= 1;
    if (remaining === 0) {
      if (exitCode === 0) {
        console.log('\nAll dev services exited cleanly.');
        console.log('(Placeholder packages exit immediately; the real apps will keep running.)');
      }
      process.exit(exitCode);
    }
  });
}
