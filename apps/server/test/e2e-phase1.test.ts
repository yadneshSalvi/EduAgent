/**
 * Phase 1 golden-path E2E — the phase's acceptance proof (plans/03 §9).
 * Boots the REAL production graph (buildApp + createServices: real codex
 * child, real workspaces, real pipeline) and drives it over HTTP + WS only:
 *
 *   local-login → POST /api/threads (onboarding greeting streams) → one
 *   onboarding answer → profile committed + memory.commit event + onboarded
 *   flips → learn thread (greeting) → SIGKILL the codex child → next turn
 *   recovers via restart + thread/resume (retryable errors allowed between).
 *
 * COSTS REAL API MONEY (≤ ~8 turns). Gated:
 *
 *   RUN_CODEX_E2E=1 pnpm --filter @eduagent/server test e2e-phase1
 *
 * Not part of CI or the default test run.
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { WebSocket } from 'ws';
import {
  meResponseSchema,
  threadItemsResponseSchema,
  threadSummarySchema,
  wsEventSchema,
  type ThreadSummary,
  type WsEvent,
} from '@eduagent/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createServices, type AppServices } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl, repoRoot } from './helpers/test-db.js';

const enabled = process.env.RUN_CODEX_E2E === '1';
const TURN_TIMEOUT_MS = 300_000;

/** Collects parsed WsEvents off one socket; unparseable frames are kept raw for pong etc. */
class Collector {
  readonly events: WsEvent[] = [];
  constructor(readonly socket: WebSocket, readonly name: string) {
    socket.on('message', (data) => {
      let json: unknown;
      try {
        json = JSON.parse(String(data));
      } catch {
        return;
      }
      const parsed = wsEventSchema.safeParse(json);
      if (parsed.success) {
        this.events.push(parsed.data);
        let extra = '';
        if (parsed.data.type === 'memory.commit') {
          extra = ` ${parsed.data.commit.type}(${parsed.data.commit.topic}): ${parsed.data.commit.headline}`;
        } else if (parsed.data.type === 'turn.error') {
          extra = ` retryable=${parsed.data.retryable} message=${parsed.data.message}`;
        }
        if (parsed.data.type !== 'message.delta' && parsed.data.type !== 'reasoning.delta') {
          console.log(`[e2e:${this.name}] ${parsed.data.type}${extra}`);
        }
      }
    });
  }

  /** First event at index ≥ from matching pred; polls until timeout. */
  async until(
    pred: (e: WsEvent) => boolean,
    opts: { from?: number; timeoutMs?: number } = {},
  ): Promise<{ event: WsEvent; index: number }> {
    const from = opts.from ?? 0;
    const deadline = Date.now() + (opts.timeoutMs ?? TURN_TIMEOUT_MS);
    for (;;) {
      for (let i = from; i < this.events.length; i++) {
        if (pred(this.events[i]!)) return { event: this.events[i]!, index: i };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `[e2e:${this.name}] timed out waiting; saw: ${this.events.map((e) => e.type).join(',')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe.runIf(enabled)('Phase 1 golden path (real codex)', () => {
  const dataDir = path.join(repoRoot, 'data', `e2e-${process.pid}-${randomBytes(3).toString('hex')}`);
  const codexHome = process.env.CODEX_HOME ?? path.join(repoRoot, 'data/spike-workspace/codex-home');

  let app: FastifyInstance | null = null;
  let prisma: PrismaClient | null = null;
  let services: AppServices | null = null;
  let baseUrl = '';
  let cookie = '';
  const sockets: WebSocket[] = [];
  let turnsSpent = 0;
  let passed = false;

  /** Every codex pid we ever saw — swept + liveness-checked in afterAll. */
  const seenCodexPids = new Set<number>();

  function childrenOf(pid: number): number[] {
    try {
      // The -f pattern keeps unrelated tooling children (bundler daemons
      // etc.) out of the tree — only codex processes are ours to kill.
      const out = execSync(`pgrep -P ${pid} -f 'app-server'`).toString().trim();
      return out === '' ? [] : out.split('\n').map(Number);
    } catch {
      return []; // pgrep exits 1 when nothing matches
    }
  }

  /**
   * The codex process TREE under this test process. The `codex` CLI is often
   * a node shim whose child is the real app-server binary — SIGKILLing only
   * the shim would orphan the vendor process, so kills and leak checks walk
   * all descendants.
   */
  function codexChildPids(): number[] {
    const tree: number[] = [];
    const walk = (pid: number) => {
      for (const child of childrenOf(pid)) {
        tree.push(child);
        walk(child);
      }
    };
    walk(process.pid);
    for (const pid of tree) seenCodexPids.add(pid);
    return tree;
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function api<T>(pathname: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie !== '' ? { cookie } : {}),
        ...init.headers,
      },
    });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${pathname} → ${res.status}: ${await res.text()}`);
    return (await res.json()) as T;
  }

  function connect(pathname: string, name: string): Promise<Collector> {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${pathname}`, {
      headers: { cookie },
    });
    sockets.push(socket);
    const collector = new Collector(socket, name);
    return new Promise((resolve, reject) => {
      socket.once('open', () => resolve(collector));
      socket.once('error', reject);
      socket.once('close', (code) => reject(new Error(`${name} closed ${code} before open`)));
    });
  }

  /** Sends one user message; resolves with the terminal event (completed or error). */
  async function runTurn(threadSocket: Collector, text: string): Promise<WsEvent> {
    const from = threadSocket.events.length;
    turnsSpent += 1;
    console.log(`[e2e] turn ${turnsSpent} →`, text);
    threadSocket.socket.send(JSON.stringify({ type: 'user.message', text }));
    const { event } = await threadSocket.until(
      (e) => e.type === 'turn.completed' || e.type === 'turn.error',
      { from },
    );
    return event;
  }

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await app?.close(); // onClose hook terminates the codex child
    await prisma?.$disconnect();
    // pgrep-verify: neither current children nor any codex pid we ever saw
    // (SIGKILL orphans included) may outlive the suite.
    expect(codexChildPids()).toEqual([]);
    const leaked = [...seenCodexPids].filter(alive);
    for (const pid of leaked) process.kill(pid, 'SIGKILL');
    expect(leaked, 'codex processes left running after close').toEqual([]);
    if (passed) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`[e2e] FAILED — workspace preserved for inspection at ${dataDir}`);
    console.log(`[e2e] total turns spent: ${turnsSpent}`);
  });

  it(
    'onboarding → memory commit → learn thread → codex crash recovery',
    { timeout: 1_500_000 },
    async () => {
      expect(fs.existsSync(path.join(codexHome, 'auth.json')), `auth.json in ${codexHome}`).toBe(true);

      // ---- boot the real server ------------------------------------------
      const databaseUrl = createTestDbUrl('e2e-phase1');
      const config = loadConfig({
        NODE_ENV: 'production', // plain pino JSON logs; e2e narrates the rest
        LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'info',
        SERVER_HOST: '127.0.0.1',
        AUTH_MODE: 'local',
        DATA_DIR: dataDir,
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: 'e2e-phase1-session-secret',
        CODEX_HOME: codexHome,
        ...(process.env.CODEX_BIN ? { CODEX_BIN: process.env.CODEX_BIN } : {}),
        ...(process.env.CODEX_MODEL ? { CODEX_MODEL: process.env.CODEX_MODEL } : {}),
      });
      prisma = createPrisma(databaseUrl);
      app = await buildApp({
        config,
        prisma,
        services: async (instance) => {
          services = await createServices({ config, prisma: prisma!, logger: instance.log });
          return services;
        },
      });
      await app.listen({ port: 0, host: '127.0.0.1' });
      baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

      const health = await api<{ ok: boolean; checks: { db: string; codex: string } }>('/healthz');
      expect(health).toEqual({ ok: true, checks: { db: 'ok', codex: 'ok' } });

      // ---- login ----------------------------------------------------------
      const loginRes = await fetch(`${baseUrl}/auth/local-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'e2e-learner' }),
      });
      expect(loginRes.status).toBe(200);
      cookie = String(loginRes.headers.get('set-cookie')).split(';')[0]!;
      const me = meResponseSchema.parse(await loginRes.json());
      expect(me.onboarded).toBe(false);

      const userSocket = await connect('/ws/user', 'user');

      // ---- onboarding thread + auto-greeting ------------------------------
      const t1 = threadSummarySchema.parse(
        await api<ThreadSummary>('/api/threads', {
          method: 'POST',
          body: JSON.stringify({ mode: 'learn' }),
        }),
      );
      turnsSpent += 1; // the auto-greeting
      const t1Socket = await connect(`/ws?threadId=${t1.id}`, 't1');
      // turn.error carries no threadId; at this point only t1 can be active.
      await userSocket.until(
        (e) =>
          (e.type === 'turn.completed' && e.threadId === t1.id) || e.type === 'turn.error',
      );
      console.log('[e2e] onboarding greeting settled');

      const greetingItems = threadItemsResponseSchema.parse(
        await api(`/api/threads/${t1.id}/items`),
      );
      const greetingAgent = greetingItems.items.filter(
        (i) => i.role === 'agent' && i.kind === 'message',
      );
      expect(greetingAgent.length).toBeGreaterThan(0);
      expect(greetingItems.items[0]).toMatchObject({ role: 'system', kind: 'message' });

      // ---- one onboarding answer → profile.md committed --------------------
      const answer =
        'My goal is passing SQL interviews. I know basic SELECT only. I prefer short sessions. ' +
        'Please skip further questions and the baseline quiz (not available here) — ' +
        'write my profile, track, and mastery seed now and commit.';
      const nudge =
        'Do it now without asking anything else: write profile.md, tracks/<track>/track.yaml, ' +
        'seed mastery, then git commit as instructed.';
      let commitSeen = false;
      let nudges = 0;
      let errors = 0;
      let text = answer;
      let terminal: WsEvent | null = null;
      // Bounded: ≤2 content nudges and ≤3 transient-error retries.
      while (nudges <= 2 && errors <= 3) {
        const from = t1Socket.events.length;
        terminal = await runTurn(t1Socket, text);
        commitSeen ||= t1Socket.events.slice(from).some((e) => e.type === 'memory.commit');
        if (terminal.type === 'turn.completed' && commitSeen) break;
        if (terminal.type === 'turn.error') {
          errors += 1;
          await new Promise((resolve) => setTimeout(resolve, 5_000));
          continue; // retry the same text (the UI's one-click retry semantic)
        }
        nudges += 1;
        text = nudge;
      }
      console.log(`[e2e] onboarding loop done — nudges=${nudges} transient errors=${errors}`);
      await dumpWorkspaceDiagnostics(me.id, 'after onboarding loop');
      expect(terminal!.type).toBe('turn.completed');
      expect(commitSeen, 'a memory.commit event on the thread socket').toBe(true);

      // QA finding M2: onboarding's FIRST write must zod-validate — a learner
      // model born broken poisons every later digest and greeting.
      const onboardedModel = await services!.workspaces.readLearnerModel(me.id);
      expect(onboardedModel.needsRepair, 'schema-invalid files right after onboarding').toEqual([]);
      expect(onboardedModel.profile, 'profile.md parsed').not.toBeNull();

      // Deltas streamed on the answer turn(s).
      expect(t1Socket.events.some((e) => e.type === 'message.delta')).toBe(true);
      // The user socket got the memory.commit too (MemoryPipeline emitter).
      const userCommit = userSocket.events.find((e) => e.type === 'memory.commit');
      expect(userCommit).toBeDefined();
      expect((userCommit as Extract<WsEvent, { type: 'memory.commit' }>).commit.sha).toMatch(/^[0-9a-f]{40}$/);

      // Ground truth: profile.md is committed; /auth/me flips.
      expect(await services!.workspaces.hasCommittedProfile(me.id)).toBe(true);
      const meAfter = meResponseSchema.parse(await api('/auth/me'));
      expect(meAfter.onboarded).toBe(true);

      // ItemMirror grew: user answer + agent output rows exist.
      const t1Items = threadItemsResponseSchema.parse(await api(`/api/threads/${t1.id}/items`));
      expect(t1Items.items.some((i) => i.role === 'user' && i.kind === 'message')).toBe(true);
      expect(t1Items.items.length).toBeGreaterThan(greetingItems.items.length);

      // ---- learn thread: greeting sees the profile -------------------------
      const t2 = threadSummarySchema.parse(
        await api<ThreadSummary>('/api/threads', {
          method: 'POST',
          body: JSON.stringify({ mode: 'learn', topicSlug: 'sql' }),
        }),
      );
      expect(t2.id).not.toBe(t1.id);
      turnsSpent += 1; // t2 auto-greeting
      const t2Socket = await connect(`/ws?threadId=${t2.id}`, 't2');
      const t2From = userSocket.events.length;
      await userSocket.until(
        (e) =>
          (e.type === 'turn.completed' && e.threadId === t2.id) || e.type === 'turn.error',
        { from: t2From },
      );
      const t2Items = threadItemsResponseSchema.parse(await api(`/api/threads/${t2.id}/items`));
      const t2Greeting = t2Items.items.filter((i) => i.role === 'agent' && i.kind === 'message');
      expect(t2Greeting.length).toBeGreaterThan(0);
      // QA finding M1: the learn greeting must open with personal recall of
      // the onboarding facts — and must not re-run a calibration interview.
      // Soft-but-real: the greeting may span several messages; recall must
      // appear in the concatenation, the anti-patterns in none of it.
      const greetingText = t2Greeting.map((i) => (i.payload as { text: string }).text).join('\n');
      expect(greetingText.length).toBeGreaterThan(0);
      console.log('[e2e] learn greeting:', greetingText.slice(0, 300));
      expect(greetingText, 'greeting recalls the learner (goal/interview/SQL)').toMatch(
        /interview|goal|sql/i,
      );
      expect(greetingText, 'greeting must not read as a first meeting').not.toMatch(
        /no prior session|calibrat/i,
      );

      // ---- kill the codex child; next turn must recover ---------------------
      const pids = codexChildPids();
      expect(pids.length).toBeGreaterThan(0);
      for (const pid of pids) process.kill(pid, 'SIGKILL');
      console.log('[e2e] SIGKILLed codex child', pids);

      let recovered = false;
      let retries = 0;
      for (let attempt = 0; attempt < 5 && !recovered; attempt++) {
        const outcome = await runTurn(
          t2Socket,
          'In one short sentence: what is my learning goal?',
        );
        if (outcome.type === 'turn.completed') {
          recovered = true;
        } else {
          expect(outcome).toMatchObject({ type: 'turn.error', retryable: true });
          retries += 1;
          await new Promise((resolve) => setTimeout(resolve, 3_000));
        }
      }
      console.log(`[e2e] recovery: recovered=${recovered} after ${retries} retryable error(s)`);
      expect(recovered).toBe(true);

      // The post-crash turn answered from resumed thread context.
      const finalItems = threadItemsResponseSchema.parse(await api(`/api/threads/${t2.id}/items`));
      const lastAgent = [...finalItems.items]
        .reverse()
        .find((i) => i.role === 'agent' && i.kind === 'message');
      expect(lastAgent).toBeDefined();
      const lastText = (lastAgent!.payload as { text: string }).text;
      expect(lastText.length).toBeGreaterThan(0);
      console.log('[e2e] post-recovery answer:', lastText.slice(0, 200));

      // ---- QA finding M3: no plumbing narration, anywhere learner-visible --
      // Broad scan is report-only (the word "commit" is sanctioned product
      // vocabulary, 00 §9); the hard patterns are the offender classes QA
      // quoted: formats/YAML/skills, "damaged/repair" narration, validation
      // of files, and tool/skill-availability talk.
      const transcript = [...t1Items.items, ...finalItems.items].filter(
        (i) =>
          i.role === 'agent' &&
          i.kind === 'message' &&
          (i.payload as { phase?: string | null }).phase !== 'commentary',
      );
      const broadPattern = /schema|yaml|commit|SKILL|tool.*(unavailable|isn't available)|validat/i;
      const hardPattern = new RegExp(
        [
          String.raw`\byaml\b`,
          String.raw`SKILL\.md`,
          String.raw`\b(memory|teach) skill\b`,
          String.raw`\b(files?|formats?|schemas?)\b[^.\n]{0,30}\b(damaged|invalid|outdated|corrupt)`,
          String.raw`\brepair(ing|ed)?\b[^.\n]{0,30}\b(files?|formats?|schemas?|memory)\b`,
          String.raw`\bvalidat\w*\b[^.\n]{0,30}\b(files?|formats?|schemas?)\b`,
          String.raw`\b(tool|quiz|control|skill)\b[^.\n]{0,50}(unavailable|isn'?t available|not available|isn'?t installed|not installed)`,
        ].join('|'),
        'i',
      );
      const broadHits: string[] = [];
      const hardHits: string[] = [];
      for (const item of transcript) {
        const text = (item.payload as { text: string }).text;
        if (broadPattern.test(text)) broadHits.push(text.slice(0, 160));
        if (hardPattern.test(text)) hardHits.push(text.slice(0, 200));
      }
      if (broadHits.length > 0) {
        console.log(`[e2e] voice-scan report-only hits (${broadHits.length}):`);
        for (const hit of broadHits) console.log(`  - ${hit}`);
      }
      expect(hardHits, 'learner-facing plumbing narration').toEqual([]);

      await dumpWorkspaceDiagnostics(me.id, 'final');
      passed = true;
    },
  );

  /** Prompt-bug telemetry: what the agent actually wrote (no assertions). */
  async function dumpWorkspaceDiagnostics(userId: string, label: string): Promise<void> {
    const ws = services!.workspaces;
    const model = await ws.readLearnerModel(userId);
    const log = execSync(`git -C ${ws.pathFor(userId)} log --oneline`).toString().trim();
    console.log(`[e2e:diag ${label}] git log:\n${log}`);
    console.log(`[e2e:diag ${label}] needsRepair: ${JSON.stringify(model.needsRepair)}`);
    console.log(`[e2e:diag ${label}] profile parsed: ${model.profile !== null}`);
    const profilePath = path.join(ws.pathFor(userId), 'profile.md');
    if (fs.existsSync(profilePath)) {
      console.log(
        `[e2e:diag ${label}] profile.md:\n${fs.readFileSync(profilePath, 'utf8').slice(0, 800)}`,
      );
    }
  }
});

// Keeps the file from being an empty suite when the gate is off.
describe.runIf(!enabled)('Phase 1 golden path (gated)', () => {
  it('is skipped unless RUN_CODEX_E2E=1', () => {
    expect(enabled).toBe(false);
  });
});
