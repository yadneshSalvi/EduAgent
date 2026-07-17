/**
 * Phase 3 review-mode E2E — the acceptance proof for the memory surfaces
 * (plans/06 Phase 3). Boots the REAL production graph and drives it over
 * HTTP + WS only:
 *
 *   fixture workspace with 3 due SRS items (2 today + 1 overdue) →
 *   GET /api/dashboard shows them (and caches) → POST /api/review/start →
 *   the agent opens the session and pushes a retrieval quiz (workbench.quiz
 *   on the review thread) → answers via POST /api/quiz/:id/submit → graded →
 *   srs/queue.yaml rescheduled per the SM-2 rules + mastery evidence + a
 *   grammar `review(...)` commit + memory.commit event → GET /api/dashboard
 *   reflects it all WITHOUT the fixture cache (reviewQueue count drops,
 *   timeline gains the review commit) — proving the onMemoryChanged
 *   invalidation wiring live.
 *
 * COSTS REAL API MONEY (~3–6 turns). Gated:
 *
 *   RUN_CODEX_E2E=1 pnpm --filter @eduagent/server test e2e-phase3
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { load as yamlLoad } from 'js-yaml';
import { WebSocket } from 'ws';
import {
  dashboardDataSchema,
  masteryFileSchema,
  meResponseSchema,
  quizPayloadSchema,
  reviewQueueResponseSchema,
  srsQueueFileSchema,
  startReviewResponseSchema,
  threadItemsResponseSchema,
  wsEventSchema,
  type QuizPayload,
  type SrsQueueItem,
  type WsEvent,
  type WsEventOf,
} from '@eduagent/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createServices, type AppServices } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl, repoRoot } from './helpers/test-db.js';
import { seedFixtureWorkspace } from './helpers/fixture-workspace.js';

const enabled = process.env.RUN_CODEX_E2E === '1';
const TURN_TIMEOUT_MS = 300_000;

class Collector {
  readonly events: WsEvent[] = [];
  constructor(
    readonly socket: WebSocket,
    readonly name: string,
  ) {
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
        if (parsed.data.type !== 'message.delta' && parsed.data.type !== 'reasoning.delta') {
          let extra = '';
          if (parsed.data.type === 'memory.commit') {
            extra = ` ${parsed.data.commit.type}(${parsed.data.commit.topic}): ${parsed.data.commit.headline}`;
          } else if (parsed.data.type === 'activity') {
            extra = ` ${parsed.data.kind}:${parsed.data.status} ${parsed.data.label.slice(0, 60)}`;
          } else if (parsed.data.type === 'quiz.graded') {
            extra = ` ${parsed.data.quizId}`;
          } else if (parsed.data.type === 'turn.error') {
            extra = ` retryable=${parsed.data.retryable} ${parsed.data.message}`;
          }
          console.log(`[e2e3:${this.name}] ${parsed.data.type}${extra}`);
        }
      }
    });
  }

  async until(
    pred: (e: WsEvent) => boolean,
    opts: { from?: number; timeoutMs?: number; label?: string } = {},
  ): Promise<{ event: WsEvent; index: number }> {
    const from = opts.from ?? 0;
    const deadline = Date.now() + (opts.timeoutMs ?? TURN_TIMEOUT_MS);
    for (;;) {
      for (let i = from; i < this.events.length; i++) {
        if (pred(this.events[i]!)) return { event: this.events[i]!, index: i };
      }
      if (Date.now() > deadline) {
        throw new Error(
          `[e2e3:${this.name}] timed out waiting for ${opts.label ?? 'event'}; saw: ${this.events
            .slice(from)
            .map((e) => e.type)
            .join(',')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  slice<T extends WsEvent['type']>(type: T, from = 0): Array<WsEventOf<T>> {
    return this.events.slice(from).filter((e): e is WsEventOf<T> => e.type === type);
  }
}

describe.runIf(enabled)('Phase 3 review golden path (real codex)', () => {
  const dataDir = path.join(
    repoRoot,
    'data',
    `e2e3-${process.pid}-${randomBytes(3).toString('hex')}`,
  );
  const codexHome = process.env.CODEX_HOME ?? path.join(repoRoot, 'data/spike-workspace/codex-home');

  let app: FastifyInstance | null = null;
  let prisma: PrismaClient | null = null;
  let services: AppServices | null = null;
  let baseUrl = '';
  let cookie = '';
  const sockets: WebSocket[] = [];
  let turnsSpent = 0;
  let passed = false;
  const seenCodexPids = new Set<number>();

  function childrenOf(pid: number): number[] {
    try {
      const out = execSync(`pgrep -P ${pid} -f 'app-server'`).toString().trim();
      return out === '' ? [] : out.split('\n').map(Number);
    } catch {
      return [];
    }
  }

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
    if (!res.ok) {
      throw new Error(`${init.method ?? 'GET'} ${pathname} → ${res.status}: ${await res.text()}`);
    }
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

  async function runTurn(
    threadSocket: Collector,
    text: string,
  ): Promise<{ terminal: WsEvent; from: number }> {
    const from = threadSocket.events.length;
    turnsSpent += 1;
    console.log(`[e2e3] turn ${turnsSpent} →`, text.slice(0, 120));
    threadSocket.socket.send(JSON.stringify({ type: 'user.message', text }));
    const { event } = await threadSocket.until(
      (e) => e.type === 'turn.completed' || e.type === 'turn.error',
      { from, label: 'turn end' },
    );
    return { terminal: event, from };
  }

  async function awaitServerTurn(threadSocket: Collector, from: number): Promise<WsEvent> {
    turnsSpent += 1;
    const { event } = await threadSocket.until(
      (e) => e.type === 'turn.completed' || e.type === 'turn.error',
      { from, label: 'server-turn end' },
    );
    return event;
  }

  const readYaml = <T>(schema: { parse: (v: unknown) => T }, file: string): T =>
    schema.parse(yamlLoad(fs.readFileSync(file, 'utf8')));

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await app?.close();
    await prisma?.$disconnect();
    expect(codexChildPids()).toEqual([]);
    const leaked = [...seenCodexPids].filter(alive);
    for (const pid of leaked) process.kill(pid, 'SIGKILL');
    expect(leaked, 'codex processes left running after close').toEqual([]);
    if (passed) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`[e2e3] FAILED — workspace preserved at ${dataDir}`);
    console.log(`[e2e3] total turns spent: ${turnsSpent}`);
  });

  it(
    'review session: quiz → graded → SM-2 reschedule + review commit → dashboard reflects it',
    { timeout: 2_400_000 },
    async () => {
      expect(fs.existsSync(path.join(codexHome, 'auth.json')), `auth.json in ${codexHome}`).toBe(
        true,
      );

      // ---- boot the real graph ---------------------------------------------
      const databaseUrl = createTestDbUrl('e2e-phase3');
      const config = loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'info',
        SERVER_HOST: '127.0.0.1',
        AUTH_MODE: 'local',
        DATA_DIR: dataDir,
        DATABASE_URL: databaseUrl,
        RELAY_PORT: '0',
        SESSION_SECRET: 'e2e-phase3-session-secret',
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

      // ---- login + seed the fixture at the real clock ----------------------
      const loginRes = await fetch(`${baseUrl}/auth/local-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'e2e3-learner' }),
      });
      expect(loginRes.status).toBe(200);
      cookie = String(loginRes.headers.get('set-cookie')).split(';')[0]!;
      const me = meResponseSchema.parse(await loginRes.json());
      const workspaceDir = services!.workspaces.pathFor(me.id);
      await seedFixtureWorkspace(workspaceDir, new Date());
      const model = await services!.workspaces.readLearnerModel(me.id);
      expect(model.needsRepair, 'fixture must be schema-valid').toEqual([]);

      const userSocket = await connect('/ws/user', 'user');
      const todayIso = new Date().toISOString().slice(0, 10);

      // ---- dashboard BEFORE (also primes the cache we expect invalidated) --
      const dashBefore = dashboardDataSchema.parse(await api('/api/dashboard'));
      expect(dashBefore.reviewQueue).toMatchObject({ dueToday: 2, overdue: 1 });
      expect(dashBefore.reviewQueue.nextConcepts[0]).toBe('select-basics');
      expect(dashBefore.timeline.length).toBe(7);
      const queue = reviewQueueResponseSchema.parse(await api('/api/review/queue'));
      expect(queue.items).toHaveLength(3);
      console.log('[e2e3] dashboard + queue baseline ✓ (3 due)');

      // ---- start the review session ----------------------------------------
      const srsBefore = readYaml(srsQueueFileSchema, path.join(workspaceDir, 'srs/queue.yaml'));
      const masteryBefore = readYaml(
        masteryFileSchema,
        path.join(workspaceDir, 'topics/sql/mastery.yaml'),
      );
      const headBefore = (await services!.workspaces.git(me.id).headSha())!;

      const { threadId } = startReviewResponseSchema.parse(
        await api('/api/review/start', { method: 'POST' }),
      );
      turnsSpent += 1; // auto-greeting
      const t = await connect(`/ws?threadId=${threadId}`, 't');
      await userSocket.until(
        (e) =>
          ((e.type === 'turn.completed' || e.type === 'turn.error') &&
            'threadId' in e &&
            e.threadId === threadId),
        { label: 'review greeting end' },
      );
      console.log('[e2e3] review greeting settled');

      // ---- the agent pushes a retrieval quiz (mirror-backed, WS-raced) -----
      const quizzesInMirror = async (): Promise<QuizPayload[]> => {
        const items = threadItemsResponseSchema.parse(await api(`/api/threads/${threadId}/items`));
        return items.items
          .filter((i) => i.kind === 'quiz')
          .flatMap((i) => {
            const parsed = quizPayloadSchema.safeParse(i.payload);
            return parsed.success ? [parsed.data] : [];
          });
      };
      let quizzes = await quizzesInMirror();
      for (let attempt = 0; attempt < 2 && quizzes.length === 0; attempt++) {
        const { terminal } = await runTurn(
          t,
          'I am ready — push the first review quiz now with ui_push_quiz.',
        );
        if (terminal.type === 'turn.error') {
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
        quizzes = await quizzesInMirror();
      }
      expect(quizzes.length, 'agent pushed a review quiz').toBeGreaterThan(0);
      const quiz = quizzes.at(-1)!;
      console.log(
        `[e2e3] quiz ${quiz.id} on [${quiz.concepts.join(', ')}]: ${quiz.questions.length} questions`,
      );

      // Review quizzes target due concepts, one at a time. Quiz concepts may
      // arrive bare ("select-basics") or topic-qualified ("sql/select-basics").
      const bareSlug = (ref: string): string => ref.split('/').at(-1)!;
      const dueConcepts = new Set(
        srsBefore.items.filter((i) => i.due <= todayIso).map((i) => i.concept),
      );
      const targeted = [...new Set(quiz.concepts.map(bareSlug))].filter((c) =>
        dueConcepts.has(c),
      );
      expect(targeted.length, 'quiz targets a due concept').toBeGreaterThan(0);

      // ---- answer it ---------------------------------------------------------
      const answers = quiz.questions.map((q) => {
        if (q.type === 'short') {
          return {
            question_id: q.id,
            answer:
              'SELECT projects the listed columns; DISTINCT removes duplicate rows. ' +
              'An INNER JOIN keeps only matching rows while LEFT JOIN keeps all left rows ' +
              'with NULLs for non-matches, and WHERE filters rows of the joined result.',
          };
        }
        return { question_id: q.id, answer: q.answer ?? '', verdict: 'correct' as const };
      });
      const fromSubmit = t.events.length;
      await api(`/api/quiz/${quiz.id}/submit`, {
        method: 'POST',
        body: JSON.stringify({ answers }),
      });
      const terminal = await awaitServerTurn(t, fromSubmit);
      expect(terminal.type, 'grading turn completed').toBe('turn.completed');

      const graded = t.slice('quiz.graded', fromSubmit).filter((e) => e.quizId === quiz.id);
      expect(graded.length, 'quiz.graded event for the review quiz').toBeGreaterThan(0);
      console.log('[e2e3] quiz graded ✓');

      // ---- SRS queue rescheduled per SM-2 (either branch is legal) ----------
      const srsAfter = readYaml(srsQueueFileSchema, path.join(workspaceDir, 'srs/queue.yaml'));
      const byConcept = (items: SrsQueueItem[], c: string) =>
        items.find((item) => item.concept === c);
      const rescheduled = targeted.filter((concept) => {
        const before = byConcept(srsBefore.items, concept)!;
        const after = byConcept(srsAfter.items, concept);
        return after !== undefined && after.due > todayIso && after.due !== before.due;
      });
      expect(rescheduled.length, 'a due concept was rescheduled into the future').toBeGreaterThan(0);
      for (const concept of rescheduled) {
        const before = byConcept(srsBefore.items, concept)!;
        const after = byConcept(srsAfter.items, concept)!;
        const passBranch =
          after.interval_days === Math.round(before.interval_days * before.ease) &&
          Math.abs(after.ease - Math.min(2.8, before.ease + 0.05)) < 1e-9;
        const failBranch =
          after.interval_days === 1 &&
          Math.abs(after.ease - Math.max(1.3, before.ease - 0.2)) < 1e-9 &&
          after.lapses === before.lapses + 1;
        expect(
          passBranch || failBranch,
          `SM-2 arithmetic for ${concept}: ${JSON.stringify({ before, after })}`,
        ).toBe(true);
        console.log(`[e2e3] ${concept} rescheduled per SM-2 (${passBranch ? 'pass' : 'fail'} branch) ✓`);
      }

      // ---- mastery evidence / assessment mirror -----------------------------
      const masteryAfter = readYaml(
        masteryFileSchema,
        path.join(workspaceDir, 'topics/sql/mastery.yaml'),
      );
      const evidenceGrew = targeted.some((concept) => {
        const before = masteryBefore.concepts.find((c) => c.id === concept);
        const after = masteryAfter.concepts.find((c) => c.id === concept);
        return (
          after !== undefined &&
          (after.evidence.length > (before?.evidence.length ?? 0) ||
            after.last_assessed === todayIso ||
            after.review_count > (before?.review_count ?? 0))
        );
      });
      const assessmentSeen = t.slice('assessment.recorded', fromSubmit).length > 0;
      expect(
        evidenceGrew || assessmentSeen,
        'mastery evidence updated or assessment recorded',
      ).toBe(true);

      // ---- a grammar `review(...)` commit + memory.commit event -------------
      const commitsSince = await services!.workspaces.git(me.id).log({ from: headBefore });
      const reviewCommits = commitsSince.filter((c) => c.message.startsWith('review('));
      expect(reviewCommits.length, 'a review(...) commit landed').toBeGreaterThan(0);
      const commitEvents = t.slice('memory.commit', fromSubmit);
      expect(
        commitEvents.some((e) => e.commit.type === 'review'),
        'memory.commit WS event with type review',
      ).toBe(true);
      const modelAfter = await services!.workspaces.readLearnerModel(me.id);
      expect(modelAfter.needsRepair, 'learner model still schema-valid').toEqual([]);

      // ---- dashboard AFTER: cache invalidated, numbers moved -----------------
      const dashAfter = dashboardDataSchema.parse(await api('/api/dashboard'));
      const dueBefore = dashBefore.reviewQueue.dueToday + dashBefore.reviewQueue.overdue;
      const dueAfter = dashAfter.reviewQueue.dueToday + dashAfter.reviewQueue.overdue;
      expect(dueAfter, 'review queue count dropped').toBeLessThan(dueBefore);
      const reviewShas = new Set(reviewCommits.map((c) => c.sha));
      expect(
        dashAfter.timeline.some((e) => reviewShas.has(e.sha) && e.type === 'review'),
        'timeline gained the review commit',
      ).toBe(true);
      console.log(
        `[e2e3] dashboard reflects the review: due ${dueBefore} → ${dueAfter}, timeline has the review commit ✓`,
      );

      // ---- memory explorer sees it too (cheap live checks) -------------------
      const log = await api<{ commits: Array<{ sha: string; type: string }> }>('/api/memory/log?limit=5');
      expect(log.commits.some((c) => reviewShas.has(c.sha))).toBe(true);
      const exportRes = await fetch(`${baseUrl}/api/memory/export`, { headers: { cookie } });
      expect(exportRes.status).toBe(200);
      expect(exportRes.headers.get('content-type')).toBe('application/zip');
      const zipHead = Buffer.from(await exportRes.arrayBuffer()).subarray(0, 2).toString('latin1');
      expect(zipHead).toBe('PK');

      passed = true;
    },
  );
});

describe.runIf(!enabled)('Phase 3 review golden path (gated)', () => {
  it('is skipped unless RUN_CODEX_E2E=1', () => {
    expect(enabled).toBe(false);
  });
});
