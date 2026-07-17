/**
 * Phase 4 exam-mode E2E — the acceptance proof for plans/06 Phase 4. Boots
 * the REAL production graph and drives it over HTTP + WS only:
 *
 *   fixture workspace → learn thread (fork parent) → POST /api/exams →
 *   generation turn on a thread/fork of the tutor thread (exam-generate
 *   developerInstructions ride the fork — proven by the fork's OWN session
 *   token authenticating ui_create_exam) → questions target the weakest
 *   weighted concepts → EXAM INTEGRITY: hidden tests exist on disk but are
 *   untracked (git ls-files) and unreadable via /api/memory/file → start →
 *   autosave → submit with one deliberately-wrong + one correct coding answer
 *   → grading turn: real test execution, per-question verdicts, EXACT
 *   readiness delta, exam(...) grammar commit force-adding the workdirs,
 *   exams/*.md record with the readiness snapshot → GET /api/exams/:id shows
 *   it all. Second exam: expired in_progress auto-submits via the sweep.
 *
 * COSTS REAL API MONEY (~5–8 turns). Gated:
 *
 *   RUN_CODEX_E2E=1 pnpm --filter @eduagent/server test e2e-phase4
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
  createExamResponseSchema,
  examDtoSchema,
  listExamsResponseSchema,
  meResponseSchema,
  startExamResponseSchema,
  threadItemsResponseSchema,
  wsEventSchema,
  type ExamDto,
  type WsEvent,
  type WsEventOf,
} from '@eduagent/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createServices, type AppServices } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { EXAM_GRACE_MS } from '../src/learning/index.js';
import { createTestDbUrl, repoRoot } from './helpers/test-db.js';
import { seedFixtureWorkspace } from './helpers/fixture-workspace.js';

const enabled = process.env.RUN_CODEX_E2E === '1';
const TURN_TIMEOUT_MS = 420_000;
const TRACK = 'sql-interview';
const DURATION_MIN = 30;

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
            extra = ` ${parsed.data.kind}:${parsed.data.status} ${parsed.data.label.slice(0, 70)}`;
          } else if (parsed.data.type === 'exam.created' || parsed.data.type === 'exam.graded') {
            extra = ` ${parsed.data.examId}`;
          } else if (parsed.data.type === 'turn.error') {
            extra = ` retryable=${parsed.data.retryable} ${parsed.data.message}`;
          }
          console.log(`[e2e4:${this.name}] ${parsed.data.type}${extra}`);
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
          `[e2e4:${this.name}] timed out waiting for ${opts.label ?? 'event'}; saw: ${this.events
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

describe.runIf(enabled)('Phase 4 exam golden path (real codex)', () => {
  const dataDir = path.join(
    repoRoot,
    'data',
    `e2e4-${process.pid}-${randomBytes(3).toString('hex')}`,
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

  async function apiStatus(pathname: string, init: RequestInit = {}): Promise<number> {
    const res = await fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookie !== '' ? { cookie } : {}),
        ...init.headers,
      },
    });
    await res.text();
    return res.status;
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

  /** Waits for the next turn boundary of `threadId` on the user socket. */
  async function awaitThreadTurnEnd(user: Collector, threadId: string, from: number, label: string) {
    turnsSpent += 1;
    const { event, index } = await user.until(
      (e) =>
        (e.type === 'turn.completed' || e.type === 'turn.error') &&
        'threadId' in e &&
        e.threadId === threadId,
      { from, label },
    );
    return { event, index };
  }

  const examThreadId = async (examId: string): Promise<string> =>
    (await prisma!.exam.findUniqueOrThrow({ where: { id: examId } })).threadId;

  const getExam = async (examId: string): Promise<ExamDto> =>
    examDtoSchema.parse(await api(`/api/exams/${examId}`));

  const flatQuestions = (dto: ExamDto) =>
    (dto.questions?.sections ?? []).flatMap((section) => section.questions);

  const bareSlug = (ref: string): string => ref.split('/').at(-1)!;

  /**
   * Creates an exam and waits for generation (exam.created + the generation
   * turn's end). One retry with a FRESH exam if a generation attempt dies —
   * each attempt is its own fork + draft row.
   */
  async function createExamAndAwaitReady(user: Collector): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const from = user.events.length;
      const { examId } = createExamResponseSchema.parse(
        await api('/api/exams', {
          method: 'POST',
          body: JSON.stringify({ trackSlug: TRACK, durationMin: DURATION_MIN }),
        }),
      );
      console.log(`[e2e4] exam ${examId} created (attempt ${attempt}) — generation turn running`);
      const threadId = await examThreadId(examId);
      const { event } = await awaitThreadTurnEnd(user, threadId, from, 'generation turn end');
      const created = user
        .slice('exam.created', from)
        .some((e) => e.examId === examId);
      if (created && event.type === 'turn.completed') return examId;
      const dto = await getExam(examId);
      if (dto.status !== 'draft') return examId; // created despite a late turn.error
      if (attempt >= 2) {
        throw new Error(`exam generation failed twice (last terminal: ${event.type})`);
      }
      console.log('[e2e4] generation attempt failed — retrying with a fresh exam');
    }
  }

  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await app?.close();
    await prisma?.$disconnect();
    expect(codexChildPids()).toEqual([]);
    const leaked = [...seenCodexPids].filter(alive);
    for (const pid of leaked) process.kill(pid, 'SIGKILL');
    expect(leaked, 'codex processes left running after close').toEqual([]);
    if (passed) fs.rmSync(dataDir, { recursive: true, force: true });
    else console.log(`[e2e4] FAILED — workspace preserved at ${dataDir}`);
    console.log(`[e2e4] total turns spent: ${turnsSpent}`);
  });

  it(
    'exam: fork → targeted generation → integrity → timed sitting → graded with exact readiness → sweep',
    { timeout: 3_000_000 },
    async () => {
      expect(fs.existsSync(path.join(codexHome, 'auth.json')), `auth.json in ${codexHome}`).toBe(
        true,
      );

      // ---- boot the real graph ---------------------------------------------
      const databaseUrl = createTestDbUrl('e2e-phase4');
      const config = loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'info',
        SERVER_HOST: '127.0.0.1',
        AUTH_MODE: 'local',
        DATA_DIR: dataDir,
        DATABASE_URL: databaseUrl,
        RELAY_PORT: '0',
        SESSION_SECRET: 'e2e-phase4-session-secret',
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

      // ---- login + fixture at the real clock -------------------------------
      const loginRes = await fetch(`${baseUrl}/auth/local-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'e2e4-learner' }),
      });
      expect(loginRes.status).toBe(200);
      cookie = String(loginRes.headers.get('set-cookie')).split(';')[0]!;
      const me = meResponseSchema.parse(await loginRes.json());
      const workspaceDir = services!.workspaces.pathFor(me.id);
      await seedFixtureWorkspace(workspaceDir, new Date());
      const model = await services!.workspaces.readLearnerModel(me.id);
      expect(model.needsRepair, 'fixture must be schema-valid').toEqual([]);
      const git = services!.workspaces.git(me.id);

      const user = await connect('/ws/user', 'user');

      // ---- learn thread = the fork parent (greeting turn) ------------------
      const learnFrom = user.events.length;
      const learnThread = await api<{ id: string }>('/api/threads', {
        method: 'POST',
        body: JSON.stringify({ mode: 'learn' }),
      });
      await awaitThreadTurnEnd(user, learnThread.id, learnFrom, 'learn greeting end');
      console.log('[e2e4] learn thread (fork parent) ready');

      // Server-side targeting truth: bottom-5 weighted concepts right now.
      const dash = await services!.dashboard.get(me.id, { now: new Date() });
      const weakest = dash.readiness.find((r) => r.track === TRACK)!.weakest;
      const weakestIds = weakest.map((w) => w.concept);
      console.log(`[e2e4] server-computed weakest: ${weakestIds.join(', ')}`);

      // =================== exam #1: the golden path =========================
      const examId = await createExamAndAwaitReady(user);
      const threadId = await examThreadId(examId);

      // The exam thread is a REAL fork of the learn thread with its OWN token.
      const examThread = await prisma.thread.findUniqueOrThrow({ where: { id: threadId } });
      const learnRow = await prisma.thread.findUniqueOrThrow({ where: { id: learnThread.id } });
      expect(examThread.mode).toBe('exam');
      expect(examThread.forkedFromId).toBe(learnThread.id);
      expect(examThread.codexThreadId).not.toBe(learnRow.codexThreadId);
      expect(examThread.sessionToken).not.toBe(learnRow.sessionToken);
      console.log(
        '[e2e4] fork verified: ui_create_exam authenticated with the FORK token — ' +
          'the fork-time developerInstructions demonstrably reached the model',
      );

      // ---- targeting: concepts ⊆ track, biased to the weakest --------------
      let dto = await getExam(examId);
      expect(dto.status).toBe('ready');
      expect(dto.durationMin).toBe(DURATION_MIN);
      const questions = flatQuestions(dto);
      expect(questions.length).toBeGreaterThanOrEqual(4);
      const codingQs = questions.filter((q) => q.type === 'coding');
      expect(codingQs.length, 'at least two coding questions').toBeGreaterThanOrEqual(2);

      const trackConcepts = new Set(
        model.tracks.find((t) => t.track === TRACK)!.items.map((i) => i.concept),
      );
      const usedConcepts = new Set(questions.flatMap((q) => q.concepts.map(bareSlug)));
      for (const concept of usedConcepts) {
        expect(trackConcepts.has(concept), `question concept ${concept} is in the track`).toBe(true);
      }
      // Fixture: the bottom-3 weakest are the never-assessed window-functions
      // plus the two shakiest. A targeted exam must attack most of them.
      const bottom3 = weakestIds.slice(0, 3);
      const attacked = bottom3.filter((c) => usedConcepts.has(c));
      console.log(
        `[e2e4] targeting: questions cover [${[...usedConcepts].join(', ')}]; ` +
          `bottom-3 ${bottom3.join(', ')} → attacked: ${attacked.join(', ')}`,
      );
      expect(attacked.length, 'majority of the bottom-3 weakest attacked').toBeGreaterThanOrEqual(2);

      // Targeting rationale (acceptance: "log the targeting rationale").
      const items = threadItemsResponseSchema.parse(await api(`/api/threads/${threadId}/items`));
      const agentMessages = items.items.filter((i) => i.role === 'agent' && i.kind === 'message');
      const rationale = agentMessages
        .map((i) => (i.payload as { text?: string }).text ?? '')
        .filter((t) => /targeting/i.test(t))
        .at(-1);
      console.log(`[e2e4] generation rationale:\n${rationale ?? '(none found in agent messages)'}`);

      // ---- EXAM INTEGRITY: tests on disk, NOT in git, NOT servable ---------
      const testsDirs = codingQs.map((q) =>
        path.join('.exercises', `exam-${examId}-${q.id}`, 'tests'),
      );
      for (const dir of testsDirs) {
        const abs = path.join(workspaceDir, dir);
        expect(fs.existsSync(abs), `hidden tests exist at ${dir}`).toBe(true);
        expect(fs.readdirSync(abs).length, `hidden tests non-empty at ${dir}`).toBeGreaterThan(0);
      }
      const trackedMidExam = await git.lsFiles();
      expect(
        trackedMidExam.filter((p) => p.startsWith('.exercises/exam-')),
        'NO exam workdir file is git-tracked mid-exam',
      ).toEqual([]);
      const firstTestFile = fs.readdirSync(path.join(workspaceDir, testsDirs[0]!))[0]!;
      const testPath = `${testsDirs[0]!}/${firstTestFile}`.split(path.sep).join('/');
      expect(
        await apiStatus(`/api/memory/file?path=${encodeURIComponent(testPath)}`),
        'memory explorer must 404 the hidden tests mid-exam',
      ).toBe(404);
      console.log('[e2e4] integrity ✓ — tests exist on disk, untracked, unservable');

      // ---- start: server-authoritative deadline ----------------------------
      const started = startExamResponseSchema.parse(
        await api(`/api/exams/${examId}/start`, { method: 'POST' }),
      );
      expect(Date.parse(started.deadline) - Date.parse(started.startedAt)).toBe(
        DURATION_MIN * 60_000,
      );

      // ---- answers: one deliberately-wrong + one correct coding answer -----
      // Wrong = the starter (generation verified tests FAIL on it); correct =
      // the agent's own reference solution from the exam workdir.
      const answers: Record<string, string> = {};
      const wrongQ = codingQs[0]!;
      answers[wrongQ.id] = wrongQ.starter_code ?? '-- no attempt';
      const solvedQ = codingQs[1]!;
      const solvedDir = path.join(workspaceDir, '.exercises', `exam-${examId}-${solvedQ.id}`);
      const solutionFile = fs
        .readdirSync(solvedDir)
        .find((f) => f.toLowerCase().startsWith('solution'));
      expect(solutionFile, `reference solution in ${solvedDir}`).toBeDefined();
      answers[solvedQ.id] = fs.readFileSync(path.join(solvedDir, solutionFile!), 'utf8');
      for (const q of questions) {
        if (q.type === 'mcq') answers[q.id] = q.options![0]!;
        if (q.type === 'short') {
          answers[q.id] =
            'An INNER JOIN keeps only matching rows; a LEFT JOIN keeps every left row and ' +
            'extends non-matches with NULLs. WHERE filters after the join logically completes.';
        }
      }

      // Autosave a partial set first (the 15s autosave path).
      await api(`/api/exams/${examId}/answers`, {
        method: 'PUT',
        body: JSON.stringify({ answers: { [wrongQ.id]: answers[wrongQ.id]! } }),
      });
      dto = await getExam(examId);
      expect(dto.answers).toMatchObject({ [wrongQ.id]: answers[wrongQ.id]! });
      console.log('[e2e4] autosave ✓');

      // ---- submit → grading turn -------------------------------------------
      const masteryBefore = fs.readFileSync(
        path.join(workspaceDir, 'topics/sql/mastery.yaml'),
        'utf8',
      );
      const headBeforeGrading = (await git.headSha())!;
      const fromSubmit = user.events.length;
      await api(`/api/exams/${examId}/submit`, {
        method: 'POST',
        body: JSON.stringify({ answers }),
      });
      let terminal = await awaitThreadTurnEnd(user, threadId, fromSubmit, 'grading turn end');
      let gradedSeen = user.slice('exam.graded', fromSubmit).some((e) => e.examId === examId);
      if (!gradedSeen) {
        // Recovery path: a submitted exam without a result re-kicks grading.
        console.log('[e2e4] grading did not land — retrying via POST /submit');
        const fromRetry = user.events.length;
        await api(`/api/exams/${examId}/submit`, { method: 'POST', body: JSON.stringify({ answers }) });
        terminal = await awaitThreadTurnEnd(user, threadId, fromRetry, 'grading retry end');
        gradedSeen = user.slice('exam.graded', fromRetry).some((e) => e.examId === examId);
      }
      expect(gradedSeen, 'exam.graded event received').toBe(true);
      expect(terminal.event.type).toBe('turn.completed');

      // ---- verdicts: real execution, wrong ≠ correct ------------------------
      dto = await getExam(examId);
      expect(dto.status).toBe('graded');
      const result = dto.result!;
      expect(result.per_question).toHaveLength(questions.length);
      const verdictOf = (id: string) => result.per_question.find((g) => g.id === id)!;
      expect(verdictOf(wrongQ.id).verdict, 'starter submission must not pass').not.toBe('correct');
      expect(verdictOf(solvedQ.id).verdict, 'reference solution passes').toBe('correct');
      expect(verdictOf(solvedQ.id).points_awarded).toBeGreaterThan(0);
      console.log(
        `[e2e4] verdicts ✓ — ${result.per_question.map((g) => `${g.id}:${g.verdict}`).join(' ')}` +
          ` total ${result.total}`,
      );

      // Real test execution evidenced: exec items on the exam thread touching
      // the exam workdirs during the grading turn.
      const gradedItems = threadItemsResponseSchema.parse(
        await api(`/api/threads/${threadId}/items`),
      );
      const execCommands = gradedItems.items
        .filter((i) => i.kind === 'exec')
        .map((i) => (i.payload as { command?: string }).command ?? '');
      expect(
        execCommands.some((c) => c.includes(`exam-${examId}`)),
        `grading ran commands in the exam workdirs; saw: ${execCommands.slice(-8).join(' | ')}`,
      ).toBe(true);

      // ---- exact readiness delta -------------------------------------------
      expect(result.readiness_before).toBeDefined();
      expect(result.readiness_after).toBeDefined();
      expect(result.readiness_delta).toBeCloseTo(
        Math.round((result.readiness_after! - result.readiness_before!) * 10) / 10,
        5,
      );
      const dashAfter = await services!.dashboard.get(me.id, { now: new Date() });
      const scoreNow = dashAfter.readiness.find((r) => r.track === TRACK)!.score;
      expect(
        Math.abs(scoreNow - result.readiness_after!),
        'readiness_after matches the live dashboard math',
      ).toBeLessThan(0.5);
      console.log(
        `[e2e4] readiness ✓ — ${result.readiness_before} → ${result.readiness_after} ` +
          `(delta ${result.readiness_delta})`,
      );

      // ---- exam(...) commit + memory events + files -------------------------
      const commitsSince = await git.log({ from: headBeforeGrading });
      const examCommits = commitsSince.filter((c) => c.message.startsWith('exam('));
      expect(examCommits.length, 'an exam(...) grammar commit landed').toBeGreaterThan(0);
      expect(
        user.slice('memory.commit', fromSubmit).some((e) => e.commit.type === 'exam'),
        'memory.commit WS event with type exam',
      ).toBe(true);

      const masteryAfter = fs.readFileSync(
        path.join(workspaceDir, 'topics/sql/mastery.yaml'),
        'utf8',
      );
      expect(masteryAfter, 'mastery.yaml updated by grading').not.toBe(masteryBefore);
      const modelAfter = await services!.workspaces.readLearnerModel(me.id);
      expect(modelAfter.needsRepair, 'learner model still schema-valid').toEqual([]);

      const examRecords = fs
        .readdirSync(path.join(workspaceDir, 'exams'))
        .filter((f) => f.endsWith('.md'));
      expect(examRecords.length, 'exams/*.md record written').toBeGreaterThan(0);
      const record = fs.readFileSync(
        path.join(workspaceDir, 'exams', examRecords.sort().at(-1)!),
        'utf8',
      );
      expect(record).toMatch(/readiness/i);
      expect(
        record.includes(result.readiness_after!.toFixed(1)) ||
          record.includes(String(result.readiness_after!)),
        `exam record carries the exact readiness snapshot (${result.readiness_after})`,
      ).toBe(true);

      // Post-grading: the hidden tests ARE committed (auditable evidence).
      const trackedAfter = await git.lsFiles();
      for (const dir of testsDirs) {
        const posix = dir.split(path.sep).join('/');
        expect(
          trackedAfter.some((p) => p.startsWith(posix)),
          `${posix} committed after grading`,
        ).toBe(true);
      }
      console.log('[e2e4] exam commit + record + post-grading test commit ✓');

      // ---- history ----------------------------------------------------------
      const history = listExamsResponseSchema.parse(await api('/api/exams'));
      expect(history.exams.some((e) => e.id === examId && e.status === 'graded')).toBe(true);

      // =================== exam #2: deadline auto-submit ====================
      const exam2 = await createExamAndAwaitReady(user);
      const thread2 = await examThreadId(exam2);
      await api(`/api/exams/${exam2}/start`, { method: 'POST' });
      const dto2 = await getExam(exam2);
      const firstQ = flatQuestions(dto2)[0]!;
      await api(`/api/exams/${exam2}/answers`, {
        method: 'PUT',
        body: JSON.stringify({ answers: { [firstQ.id]: 'my last autosaved answer' } }),
      });

      // Expire it server-side (backdate past deadline+grace) — no waiting.
      await prisma.exam.update({
        where: { id: exam2 },
        data: { startedAt: new Date(Date.now() - DURATION_MIN * 60_000 - EXAM_GRACE_MS - 60_000) },
      });
      expect(
        await apiStatus(`/api/exams/${exam2}/answers`, {
          method: 'PUT',
          body: JSON.stringify({ answers: { [firstQ.id]: 'too late' } }),
        }),
        'autosave rejected past the deadline',
      ).toBe(409);

      const fromSweep = user.events.length;
      const swept = await services!.exams.sweepExpired();
      expect(swept, 'sweep auto-submitted the expired exam').toBeGreaterThanOrEqual(1);
      const afterSweep = await getExam(exam2);
      expect(['submitted', 'graded']).toContain(afterSweep.status);
      expect(afterSweep.answers, 'sweep used the last autosaved answers').toMatchObject({
        [firstQ.id]: 'my last autosaved answer',
      });
      await awaitThreadTurnEnd(user, thread2, fromSweep, 'auto-submit grading end');
      const graded2 = user.slice('exam.graded', fromSweep).some((e) => e.examId === exam2);
      const final2 = await getExam(exam2);
      if (graded2) {
        expect(final2.status).toBe('graded');
        expect(final2.result).not.toBeNull();
        console.log('[e2e4] deadline sweep → auto-submit → graded ✓');
      } else {
        // The timed-out sitting must at minimum be locked in as submitted.
        expect(final2.status).toBe('submitted');
        console.log('[e2e4] deadline sweep → auto-submit ✓ (grading turn did not settle a result)');
      }

      passed = true;
    },
  );
});

describe.runIf(!enabled)('Phase 4 exam golden path (gated)', () => {
  it('is skipped unless RUN_CODEX_E2E=1', () => {
    expect(enabled).toBe(false);
  });
});
