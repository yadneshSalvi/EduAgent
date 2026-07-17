/**
 * Real-binary smoke test — excluded from default runs; enable with:
 *
 *   RUN_CODEX_SMOKE=1 pnpm --filter @eduagent/server test appserver-smoke
 *
 * Uses the Phase 0 spike's isolated CODEX_HOME (already authenticated via
 * `codex login --with-api-key`, PROTOCOL_NOTES §10) — never touches ~/.codex.
 * One tiny turn; costs a few hundred tokens.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { AppServerClient, type ThreadEvent } from '../src/codex/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const spikeCodexHome = path.join(repoRoot, 'data/spike-workspace/codex-home');

const enabled = process.env.RUN_CODEX_SMOKE === '1';

describe.runIf(enabled)('codex app-server smoke (real binary)', () => {
  let client: AppServerClient | null = null;
  let workspace: string | null = null;

  afterAll(async () => {
    await client?.close();
    if (workspace !== null) fs.rmSync(workspace, { recursive: true, force: true });
  });

  it(
    'handshake → healthProbe ok → one turn streams deltas and completes',
    { timeout: 120_000 },
    async () => {
      const codexHome = process.env.CODEX_HOME ?? spikeCodexHome;
      expect(fs.existsSync(path.join(codexHome, 'auth.json')), `auth.json in ${codexHome}`).toBe(
        true,
      );
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'eduagent-smoke-'));

      client = new AppServerClient({
        codexBin: process.env.CODEX_BIN ?? 'codex',
        defaultModel: process.env.CODEX_MODEL ?? 'gpt-5.6-sol',
        env: { CODEX_HOME: codexHome },
      });
      await client.start();
      expect(client.isRunning).toBe(true);

      const probe = await client.healthProbe();
      expect(probe).toMatchObject({ ok: true, running: true, authenticated: true });

      const models = await client.listModels();
      expect(models.data.map((m) => m.model)).toContain('gpt-5.6-sol');

      const thread = await client.startThread({
        cwd: workspace,
        developerInstructions: 'You are a smoke test. Follow instructions exactly.',
      });
      const threadId = thread.thread.id;

      const events: ThreadEvent[] = [];
      const completed = new Promise<ThreadEvent>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('turn/completed never arrived')), 90_000);
        client?.onThreadEvent(threadId, (event) => {
          events.push(event);
          if (event.type === 'turnCompleted') {
            clearTimeout(timer);
            resolve(event);
          }
        });
      });

      const turn = await client.startTurn(threadId, 'Reply with exactly: pong', {
        effort: 'low',
        summary: 'auto',
      });
      expect(turn.turn.id).toBeTypeOf('string');

      const done = await completed;
      expect(done).toMatchObject({ turn: { status: 'completed' } });

      const deltas = events
        .filter((e) => e.type === 'agentMessageDelta')
        .map((e) => (e as { delta: string }).delta)
        .join('');
      expect(deltas.toLowerCase()).toContain('pong');

      await client.close();
      expect(client.isRunning).toBe(false);
      client = null;
    },
  );
});

// Keeps the file from being an empty suite when the gate is off.
describe.runIf(!enabled)('codex app-server smoke (gated)', () => {
  it('is skipped unless RUN_CODEX_SMOKE=1', () => {
    expect(enabled).toBe(false);
  });
});
