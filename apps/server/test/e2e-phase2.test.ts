/**
 * Phase 2 golden-path E2E — the workbench acceptance proof (plans/06 Phase 2).
 * Boots the REAL production graph (relay + codex + mcp-ui-tools registration)
 * and drives it over HTTP + WS only:
 *
 *   seeded (pre-onboarded) learner → learn thread → agent pushes a real
 *   exercise (hidden tests on disk, sanitized client payload) → WRONG
 *   submission (the unmodified starter) → failed verdict, feedback without
 *   the solution → correct submission (the agent's own reference solution)
 *   → passed verdict + assessment.recorded + memory commit whose deltas
 *   match the tool call → quiz push/submit/graded → artifact push with a
 *   TEMPORARILY BROKEN session token (instructive 401 → in-turn recovery).
 *
 * COSTS REAL API MONEY (~8–12 turns). Gated:
 *
 *   RUN_CODEX_E2E=1 pnpm --filter @eduagent/server test e2e-phase2
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
  exerciseDtoSchema,
  meResponseSchema,
  threadItemsResponseSchema,
  threadSummarySchema,
  wsEventSchema,
  type ExerciseDto,
  type ThreadSummary,
  type WsEvent,
  type WsEventOf,
} from '@eduagent/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createServices, type AppServices } from '../src/boot.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl, repoRoot } from './helpers/test-db.js';

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
          } else if (parsed.data.type === 'exercise.graded') {
            extra = ` ${parsed.data.exerciseId} → ${parsed.data.verdict}`;
          } else if (parsed.data.type === 'turn.error') {
            extra = ` retryable=${parsed.data.retryable} ${parsed.data.message}`;
          }
          console.log(`[e2e2:${this.name}] ${parsed.data.type}${extra}`);
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
          `[e2e2:${this.name}] timed out waiting for ${opts.label ?? 'event'}; saw: ${this.events
            .slice(from)
            .map((e) => e.type)
            .join(',')}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** All events in [from, now) matching pred. */
  slice<T extends WsEvent['type']>(type: T, from = 0): Array<WsEventOf<T>> {
    return this.events.slice(from).filter((e): e is WsEventOf<T> => e.type === type);
  }
}

describe.runIf(enabled)('Phase 2 workbench golden path (real codex)', () => {
  const dataDir = path.join(
    repoRoot,
    'data',
    `e2e2-${process.pid}-${randomBytes(3).toString('hex')}`,
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
  let toolFailuresSeen = 0;
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

  /** Sends one user message; resolves with (terminalEvent, fromIndex). */
  async function runTurn(
    threadSocket: Collector,
    text: string,
  ): Promise<{ terminal: WsEvent; from: number }> {
    const from = threadSocket.events.length;
    turnsSpent += 1;
    console.log(`[e2e2] turn ${turnsSpent} →`, text.slice(0, 120));
    threadSocket.socket.send(JSON.stringify({ type: 'user.message', text }));
    const { event } = await threadSocket.until(
      (e) => e.type === 'turn.completed' || e.type === 'turn.error',
      { from, label: 'turn end' },
    );
    return { terminal: event, from };
  }

  /** Waits for the NEXT turn (started by the server, e.g. grading) to settle. */
  async function awaitServerTurn(threadSocket: Collector, from: number): Promise<WsEvent> {
    turnsSpent += 1;
    const { event } = await threadSocket.until(
      (e) => e.type === 'turn.completed' || e.type === 'turn.error',
      { from, label: 'server-turn end' },
    );
    return event;
  }

  /** Pre-onboarded learner: valid learner-model files + the profile commit. */
  async function seedOnboardedWorkspace(userId: string): Promise<void> {
    const ws = services!.workspaces;
    await ws.ensureWorkspace(userId);
    const dir = ws.pathFor(userId);
    const today = new Date().toISOString().slice(0, 10);
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content, 'utf8');
    };
    write(
      'profile.md',
      [
        '---',
        'name: Casey',
        'goal: Get comfortable with Python basics for data work',
        'tracks: [python-basics]',
        'preferences:',
        '  session_length: short',
        '  style: direct',
        'timezone: UTC',
        '---',
        '',
        'Casey is a data analyst comfortable with spreadsheets, new to Python.',
        'Learns best from concrete examples; likes short focused sessions.',
      ].join('\n'),
    );
    write(
      'tracks/python-basics.yaml',
      [
        'track: python-basics',
        'display_name: Python Basics',
        'items:',
        '  - concept: variables-and-types',
        '    topic: python',
        '    weight: 1.0',
        '  - concept: list-operations',
        '    topic: python',
        '    weight: 1.5',
        '  - concept: for-loops',
        '    topic: python',
        '    weight: 1.2',
      ].join('\n'),
    );
    write(
      'topics/python/mastery.yaml',
      [
        'topic: python',
        'display_name: Python',
        `updated: ${new Date().toISOString()}`,
        'concepts:',
        '  - id: variables-and-types',
        '    name: Variables and types',
        '    mastery: 0.55',
        '    confidence: medium',
        `    last_assessed: ${today}`,
        '    review_count: 1',
        '    prereqs: []',
        '    evidence:',
        `      - date: ${today}`,
        "        note: 'Onboarding interview: assigns variables confidently'",
        '  - id: list-operations',
        '    name: List operations',
        '    mastery: 0.25',
        '    confidence: low',
        `    last_assessed: ${today}`,
        '    review_count: 0',
        '    prereqs: [variables-and-types]',
        '    evidence:',
        `      - date: ${today}`,
        "        note: 'Onboarding interview: unsure about slicing and append vs extend'",
      ].join('\n'),
    );
    write('srs/queue.yaml', 'items: []\n');
    await ws.git(userId).commitAll('profile: initialize learner model');
    const model = await ws.readLearnerModel(userId);
    expect(model.needsRepair, 'seeded workspace must be schema-valid').toEqual([]);
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
    else console.log(`[e2e2] FAILED — workspace preserved at ${dataDir}`);
    console.log(`[e2e2] total turns spent: ${turnsSpent}; tool failures observed: ${toolFailuresSeen}`);
  });

  it(
    'exercise fail→pass, matching deltas, quiz, artifact with token recovery',
    { timeout: 2_400_000 },
    async () => {
      expect(fs.existsSync(path.join(codexHome, 'auth.json')), `auth.json in ${codexHome}`).toBe(
        true,
      );

      // ---- boot the real graph (relay on an ephemeral port) ----------------
      const databaseUrl = createTestDbUrl('e2e-phase2');
      const config = loadConfig({
        NODE_ENV: 'production',
        LOG_LEVEL: process.env.E2E_LOG_LEVEL ?? 'info',
        SERVER_HOST: '127.0.0.1',
        AUTH_MODE: 'local',
        DATA_DIR: dataDir,
        DATABASE_URL: databaseUrl,
        RELAY_PORT: '0',
        SESSION_SECRET: 'e2e-phase2-session-secret',
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
      console.log(`[e2e2] relay bound on 127.0.0.1:${services!.relayPort}`);

      const health = await api<{ ok: boolean; checks: { db: string; codex: string } }>('/healthz');
      expect(health).toEqual({ ok: true, checks: { db: 'ok', codex: 'ok' } });

      // ---- login + seed a pre-onboarded learner ----------------------------
      const loginRes = await fetch(`${baseUrl}/auth/local-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: 'e2e2-learner' }),
      });
      expect(loginRes.status).toBe(200);
      cookie = String(loginRes.headers.get('set-cookie')).split(';')[0]!;
      const me = meResponseSchema.parse(await loginRes.json());
      await seedOnboardedWorkspace(me.id);
      const meAfter = meResponseSchema.parse(await api('/auth/me'));
      expect(meAfter.onboarded).toBe(true);

      const userSocket = await connect('/ws/user', 'user');

      // ---- learn thread (greeting must NOT re-onboard) ---------------------
      const thread = threadSummarySchema.parse(
        await api<ThreadSummary>('/api/threads', {
          method: 'POST',
          body: JSON.stringify({ mode: 'learn', topicSlug: 'python' }),
        }),
      );
      turnsSpent += 1; // auto-greeting
      const t = await connect(`/ws?threadId=${thread.id}`, 't');
      await userSocket.until(
        (e) => (e.type === 'turn.completed' && e.threadId === thread.id) || e.type === 'turn.error',
        { label: 'greeting end' },
      );
      console.log('[e2e2] greeting settled');
      const workspaceDir = services!.workspaces.pathFor(me.id);

      // ---- the agent authors + pushes a real exercise ----------------------
      let exercise: WsEventOf<'workbench.exercise'>['exercise'] | null = null;
      {
        let text =
          'I want hands-on practice on Python list operations. Author a small beginner ' +
          'coding exercise (python) and push it to my editor NOW with ui_push_exercise — ' +
          'write the hidden tests and reference solution first, per your process. ' +
          'Keep the chat part brief.';
        for (let attempt = 0; attempt < 3 && exercise === null; attempt++) {
          const { terminal, from } = await runTurn(t, text);
          const pushed = t.slice('workbench.exercise', from);
          if (pushed.length > 0) {
            exercise = pushed[0]!.exercise;
            break;
          }
          if (terminal.type === 'turn.error') {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          text =
            'Please push that exercise to my editor now using the ui_push_exercise tool — ' +
            'I am ready.';
        }
      }
      expect(exercise, 'agent pushed an exercise (workbench.exercise event)').not.toBeNull();
      console.log(`[e2e2] exercise pushed: ${exercise!.id} "${exercise!.title}"`);

      // Client payload is sanitized (tests_path/session_token stripped).
      expect(exercise).not.toHaveProperty('tests_path');
      expect(exercise).not.toHaveProperty('session_token');
      expect(exercise!.language.toLowerCase()).toContain('py');

      // Hidden tests exist on disk, gitignore-independent ground truth.
      const exerciseDir = path.join(workspaceDir, '.exercises', exercise!.id);
      const testsDir = path.join(exerciseDir, 'tests');
      expect(fs.existsSync(testsDir), `hidden tests dir ${testsDir}`).toBe(true);
      expect(fs.readdirSync(testsDir).length).toBeGreaterThan(0);

      // The mirrored exercise_ref (history hydration) is sanitized too.
      const items = threadItemsResponseSchema.parse(await api(`/api/threads/${thread.id}/items`));
      const exerciseRef = items.items.find((i) => i.kind === 'exercise_ref');
      expect(exerciseRef).toBeDefined();
      expect(exerciseRef!.payload).not.toHaveProperty('tests_path');

      // GET /api/exercises/:id serves the workbench.
      const dto = exerciseDtoSchema.parse(await api<ExerciseDto>(`/api/exercises/${exercise!.id}`));
      expect(dto.status).toBe('open');

      // ---- WRONG submission: the unmodified starter must FAIL --------------
      // (this behaviorally proves the hidden tests fail-on-starter)
      {
        const from = t.events.length;
        await api(`/api/exercises/${exercise!.id}/submit`, {
          method: 'POST',
          body: JSON.stringify({ code: exercise!.starter_code }),
        });
        const graded = await (async () => {
          await awaitServerTurn(t, from);
          return t.slice('exercise.graded', from);
        })();
        expect(graded.length, 'exercise.graded after wrong submission').toBeGreaterThan(0);
        expect(graded[0]!.verdict).toBe('failed');
        expect(graded[0]!.feedback.length).toBeGreaterThan(0);

        // The agent really RAN something (exec activity during grading).
        const execs = t.slice('activity', from).filter((a) => a.kind === 'exec');
        expect(execs.length, 'grading turn ran commands in the sandbox').toBeGreaterThan(0);

        // Feedback must not reveal the reference solution.
        const solutionFile = fs
          .readdirSync(exerciseDir)
          .find((f) => f.toLowerCase().startsWith('solution'));
        expect(solutionFile, `reference solution in ${exerciseDir}`).toBeDefined();
        const solutionBody = fs.readFileSync(path.join(exerciseDir, solutionFile!), 'utf8').trim();
        expect(
          graded[0]!.feedback.includes(solutionBody),
          'feedback must not contain the full solution',
        ).toBe(false);
        console.log('[e2e2] wrong submission → failed verdict with feedback ✓');
      }

      // ---- CORRECT submission: the agent's own reference solution ----------
      let passDeltas: Array<{ concept: string; from: number; to: number }> = [];
      {
        const solutionFile = fs
          .readdirSync(exerciseDir)
          .find((f) => f.toLowerCase().startsWith('solution'))!;
        const solutionCode = fs.readFileSync(path.join(exerciseDir, solutionFile), 'utf8');
        const from = t.events.length;
        await api(`/api/exercises/${exercise!.id}/submit`, {
          method: 'POST',
          body: JSON.stringify({ code: solutionCode }),
        });
        await awaitServerTurn(t, from);
        const graded = t.slice('exercise.graded', from);
        expect(graded.length, 'exercise.graded after correct submission').toBeGreaterThan(0);
        expect(graded.at(-1)!.verdict).toBe('passed');

        // Mastery ticker + ledger: assessment.recorded AND a memory.commit
        // whose headline deltas MATCH the tool call (plans/06 Phase 2).
        const assessments = t.slice('assessment.recorded', from);
        expect(assessments.length, 'assessment.recorded on the pass turn').toBeGreaterThan(0);
        const commits = t.slice('memory.commit', from);
        expect(commits.length, 'memory commit on the pass turn').toBeGreaterThan(0);
        const commitDeltas = commits.flatMap((c) => c.commit.deltas);
        expect(commitDeltas.length, 'commit headline carries parseable deltas').toBeGreaterThan(0);
        passDeltas = assessments.flatMap((a) =>
          a.concept_deltas.map((d) => ({ concept: d.concept, from: d.from, to: d.to })),
        );
        const r2 = (n: number) => Math.round(n * 100) / 100;
        for (const delta of commitDeltas) {
          const match = passDeltas.find(
            (d) =>
              d.concept === delta.concept &&
              r2(d.from) === r2(delta.from) &&
              r2(d.to) === r2(delta.to),
          );
          expect(
            match,
            `commit delta ${delta.concept} ${delta.from}→${delta.to} matches a ui_record_assessment delta`,
          ).toBeDefined();
        }
        console.log('[e2e2] correct submission → passed; commit deltas match assessment ✓');

        const dtoAfter = exerciseDtoSchema.parse(await api(`/api/exercises/${exercise!.id}`));
        expect(dtoAfter.status).toBe('passed');
        expect(dtoAfter.attempts!.filter((a) => a.verdict !== null)).toHaveLength(2);
      }

      // ---- quiz: push → submit → graded ------------------------------------
      let quiz: WsEventOf<'workbench.quiz'>['quiz'] | null = null;
      {
        let text =
          'Quick check-in: push a 2-question quiz on list operations with ui_push_quiz — ' +
          'exactly one multiple-choice question and one short-answer question. Push it now.';
        for (let attempt = 0; attempt < 3 && quiz === null; attempt++) {
          const { terminal, from } = await runTurn(t, text);
          const pushed = t.slice('workbench.quiz', from);
          if (pushed.length > 0) {
            quiz = pushed[0]!.quiz;
            break;
          }
          if (terminal.type === 'turn.error') {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            continue;
          }
          text = 'Please push that quiz now with the ui_push_quiz tool.';
        }
      }
      expect(quiz, 'agent pushed a quiz').not.toBeNull();
      const mcq = quiz!.questions.find((q) => q.type === 'mcq' || q.type === 'predict_output');
      const short = quiz!.questions.find((q) => q.type === 'short');
      expect(mcq, 'quiz has an instant-checkable question').toBeDefined();
      expect(short, 'quiz has a short-answer question').toBeDefined();
      // Accepted decision: the client payload carries the mcq answer.
      expect(mcq!.answer).toBeDefined();

      {
        const from = t.events.length;
        await api(`/api/quiz/${quiz!.id}/submit`, {
          method: 'POST',
          body: JSON.stringify({
            answers: [
              { question_id: mcq!.id, answer: mcq!.answer!, verdict: 'correct' },
              {
                question_id: short!.id,
                answer:
                  'I think it modifies the list in place and returns None, but I am not sure why.',
              },
            ],
          }),
        });
        await awaitServerTurn(t, from);
        const graded = t.slice('quiz.graded', from);
        expect(graded.length, 'quiz.graded event').toBeGreaterThan(0);
        expect(graded[0]!.quizId).toBe(quiz!.id);
        const shortResult = graded[0]!.results.find((r) => r.question_id === short!.id);
        expect(shortResult, 'short answer got a verdict').toBeDefined();
        expect(['correct', 'partial', 'incorrect']).toContain(shortResult!.verdict);
        expect(shortResult!.feedback_md.length).toBeGreaterThan(0);
        console.log(`[e2e2] quiz graded: short → ${shortResult!.verdict} ✓`);
      }

      // ---- artifact with a TEMPORARILY broken token (instructive-error path)
      {
        const threadRow = await prisma.thread.findUnique({ where: { id: thread.id } });
        const realToken = threadRow!.sessionToken;
        await prisma.thread.update({
          where: { id: thread.id },
          data: { sessionToken: `broken-${randomBytes(6).toString('hex')}` },
        });
        console.log('[e2e2] session token broken in DB — expecting instructive 401 → recovery');

        const from = t.events.length;
        const turnPromise = runTurn(
          t,
          'Show me a small self-contained HTML visual of how Python negative list indexing ' +
            'maps to positions — push it with ui_push_artifact.',
        );
        // Restore the token as soon as the FIRST tool call settles (that call
        // fails with the instructive 401 the agent must react to).
        await t.until(
          (e) => e.type === 'activity' && e.kind === 'tool' && e.status !== 'started',
          { from, label: 'first tool-call settle' },
        );
        toolFailuresSeen += 1;
        await prisma.thread.update({
          where: { id: thread.id },
          data: { sessionToken: realToken },
        });
        console.log('[e2e2] token restored — the agent should retry in-turn');
        await turnPromise;

        let artifacts = t.slice('workbench.artifact', from);
        const recoveredInTurn = artifacts.length > 0;
        if (!recoveredInTurn) {
          // Fallback: one nudge turn still proves recovery FROM the error.
          const { from: from2 } = await runTurn(t, 'Please push that visual again now.');
          await new Promise((resolve) => setTimeout(resolve, 500));
          artifacts = t.slice('workbench.artifact', from2);
        }
        expect(artifacts.length, 'artifact delivered after token recovery').toBeGreaterThan(0);
        expect(artifacts[0]!.artifact.html.length).toBeGreaterThan(20);
        console.log(
          `[e2e2] artifact recovered ${recoveredInTurn ? 'IN-TURN' : 'on the nudge turn'} ✓`,
        );
      }

      // ---- cross-checks ----------------------------------------------------
      // Quiz + exercise refs are mirrored for hydration.
      const finalItems = threadItemsResponseSchema.parse(
        await api(`/api/threads/${thread.id}/items`),
      );
      expect(finalItems.items.some((i) => i.kind === 'quiz')).toBe(true);
      expect(finalItems.items.some((i) => i.kind === 'exercise_ref')).toBe(true);
      // The user socket received the pass verdict + assessment too (dashboard feeds).
      expect(userSocket.slice('exercise.graded').some((e) => e.verdict === 'passed')).toBe(true);
      expect(userSocket.slice('assessment.recorded').length).toBeGreaterThan(0);

      // Learner-model ground truth: mastery file changed and stayed valid.
      const model = await services!.workspaces.readLearnerModel(me.id);
      expect(model.needsRepair).toEqual([]);
      if (passDeltas.length > 0) {
        const log = execSync(`git -C ${workspaceDir} log --oneline`).toString().trim();
        console.log(`[e2e2] final git log:\n${log}`);
      }

      passed = true;
    },
  );
});

describe.runIf(!enabled)('Phase 2 workbench golden path (gated)', () => {
  it('is skipped unless RUN_CODEX_E2E=1', () => {
    expect(enabled).toBe(false);
  });
});
