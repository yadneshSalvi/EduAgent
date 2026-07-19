/**
 * ThreadManager (plans/03 §3.1): owns the Thread row ⇄ codex thread mapping,
 * serializes turns per thread, prepends the per-turn context envelope, maps
 * codex thread events onto the shared WsEvent union for the gateway, and
 * mirrors turn items to ItemMirror (the UiToolRelay also mirrors its
 * exercise/quiz pushes).
 *
 * Mode note (web contract, apps/web onboarding-wizard): the web always
 * creates `mode:"learn"` threads; a learner without a committed profile.md
 * gets ONBOARDING developerInstructions on that thread. Instructions are
 * rebuilt from current state on every thread/resume — but note codex 0.144.4
 * DROPS resume-time developerInstructions (PROTOCOL_NOTES Phase 4A addendum),
 * so the onboarding→learn rotation never actually reaches the model; it is
 * benign only because both templates share the thread's session token. Exam
 * threads, where rotation is correctness-critical, deliver instructions via
 * thread/inject_items instead (see resume()).
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient, Thread } from '@prisma/client';
import {
  localDate,
  sessionLogFrontmatterSchema,
  trackIntakeSchema,
  type TrackIntake,
  type ThreadMode,
  type WsEvent,
} from '@eduagent/shared';
import type { AppServerClient, CodexLogger, ThreadEvent } from '../codex/index.js';
import { parseExamConfig, type ExamTarget } from '../learning/exam-config.js';
import {
  buildContextEnvelope,
  buildExamGenerateInstructions,
  buildExamGradeInstructions,
  buildLearnInstructions,
  buildOnboardingInstructions,
  buildPlanInstructions,
  buildReviewInstructions,
  formatReviewDueNotes,
} from '../prompts/index.js';
import { formatStateDigest, parseFrontmatterFile } from '../workspace/index.js';
import type { MemoryPipeline, WorkspaceManager } from '../workspace/index.js';

/** Fixed input line for the auto-greeting turn run when a thread is created. */
export const GREETING_INPUT = '[session-start]';

/** How the manager pushes mapped events out; the WS gateway implements this. */
export interface ThreadEventSink {
  emitToThread(threadId: string, event: WsEvent): void;
  emitToUser(userId: string, event: WsEvent): void;
}

export interface EnsureThreadResult {
  thread: Thread;
  created: boolean;
}

/** What routes and the WS gateway need — tests inject fakes against this. */
export interface ThreadService {
  ensureThread(
    userId: string,
    mode: ThreadMode,
    opts?: { topicSlug?: string | null },
  ): Promise<EnsureThreadResult>;
  startTurn(thread: Thread, userText: string): Promise<void>;
  /**
   * Server-initiated turn (exercise/quiz grading, plans/03 §3.5): mirrored
   * with role "system" so it never renders as a learner message. `caption`
   * is the short human line the chat shows for this row on history reload —
   * without it the FULL internal instruction text would render.
   */
  startSystemTurn(thread: Thread, text: string, opts?: { caption?: string }): Promise<void>;
  interrupt(threadId: string): Promise<void>;
  turnInFlight(threadId: string): boolean;
  /** Thread row ids of this user's in-flight turns (reconnect snapshot). */
  inFlightThreads(userId: string): string[];
  resumeAll(): Promise<void>;
}

/** What ExamService needs to fork an exam thread (see forkForExam). */
export interface ExamForkOptions {
  examId: string;
  trackSlug: string;
  durationMin: number;
  /** Server-computed bottom-5 weighted concepts, weakest first. */
  targeting: ExamTarget[];
}

/**
 * The exam-mode extension of ThreadService (plans/03 §3.1 `forkForExam`).
 * Kept separate so route/gateway fakes keep implementing the lean interface.
 */
export interface ExamThreadService extends ThreadService {
  forkForExam(parent: Thread, opts: ExamForkOptions): Promise<Thread>;
  /**
   * Forces the next turn on this thread to re-`thread/resume` with freshly
   * built developerInstructions — and, for exam threads, to INJECT them as a
   * developer message (the only channel 0.144.4 actually delivers on an
   * existing thread). The rotation mechanism when a thread's mode context
   * changes materially (plans/03 §3.1; exam threads rotate generate → grade
   * instructions at submit).
   */
  invalidateInstructions(thread: Thread): void;
}

/** TrackService's thread operations, including the shared workspace queue. */
export interface TrackThreadService extends ThreadService {
  runExclusive<T>(userId: string, job: () => Promise<T>): Promise<T>;
  createPlanThread(
    userId: string,
    opts: { trackSlug: string; intake: TrackIntake },
  ): Promise<Thread>;
  createTrackSession(
    userId: string,
    opts: { trackSlug: string; day: number; intent: 'teach' | 'revise' | 'mistakes' },
  ): Promise<Thread>;
}

export interface ThreadManagerDeps {
  prisma: PrismaClient;
  client: AppServerClient;
  workspaces: WorkspaceManager;
  memory: Pick<MemoryPipeline, 'beforeTurn' | 'afterTurn'>;
  sink: ThreadEventSink;
  logger?: CodexLogger;
  /** Fail-safe ceiling per turn (default 10 min) so a hung turn can't wedge the queue. */
  turnTimeoutMs?: number;
  /**
   * Max USER turn starts per profile per LOCAL day (the user's timezone);
   * 0/absent = no quota. System turns (greeting, grading, kickoffs) are
   * exempt — the quota protects API credits from chat volume, and a refused
   * grading turn would strand submitted work (plans/08 §5).
   */
  dailyTurnQuota?: number;
}

type ItemCompletedEvent = Extract<ThreadEvent, { type: 'itemCompleted' }>;
type CodexItem = ItemCompletedEvent['item'];

type TurnOutcome =
  | { kind: 'completed'; status: string; errorMessage: string | null }
  | { kind: 'aborted'; message: string };

interface InFlightTurn {
  turnId: string;
  userId: string;
  codexThreadId: string;
}

/**
 * Completion waiter for one turn. `expectedTurnId` is null between sending
 * turn/start and its response; matching completions arriving in that window
 * are buffered (bufferedOutcomes) and consumed once the id is known. A
 * completion whose turn id matches neither is STALE (e.g. the previous turn
 * finishing after its fail-safe fired) and must never settle this waiter —
 * the Phase 1 carry-over (c) bug.
 */
interface TurnWaiter {
  expectedTurnId: string | null;
  resolve: (outcome: TurnOutcome) => void;
}

const NOOP_LOGGER: CodexLogger = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * Prefixed to the exam instruction block injected into a forked exam thread
 * (see resume()). The fork's transcript still contains the tutor's developer
 * instructions with the TUTOR's session_token — observed live: without this
 * supersession the model authenticates ui_create_exam with the parent token.
 */
export const EXAM_INJECT_PREAMBLE =
  'INSTRUCTION UPDATE for this thread. Everything below supersedes ALL earlier ' +
  'developer instructions above, including any earlier session_token — the ONLY ' +
  'valid session_token for ui_* tool calls on this thread is the one stated below.\n\n';

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * ActivityEvent.kind recording one USER turn start (quota bookkeeping only —
 * written only while a quota is configured; the dashboard heatmap excludes it).
 */
export const TURN_START_EVENT = 'turn_start';

/** Covers every UTC offset (±14h) when bucketing recent events by local day. */
const QUOTA_LOOKBACK_MS = 26 * 3_600_000;

/** What the chat shows when the day's allowance is used up — terminal, not a retry. */
export const DAILY_QUOTA_MESSAGE =
  "This profile has used today's turn allowance. It resets at midnight " +
  '(profile local time) — everything learned so far is saved.';

/**
 * Thrown by startTurn when the profile's daily USER-turn quota is exhausted.
 * The manager has already emitted the terminal turn.error to the sockets;
 * REST initiators map this to a clean 429 via `statusCode`.
 */
export class DailyTurnQuotaError extends Error {
  readonly statusCode = 429;
  constructor(readonly quota: number) {
    super(`daily turn quota reached (${quota} user turns per local day)`);
    this.name = 'DailyTurnQuotaError';
  }
}

/** Activity-chip label cap; the web settles chips by exact label match. */
const ACTIVITY_LABEL_MAX = 80;
/** Mirrored exec output cap — ItemMirror is a render cache, not a log store. */
const EXEC_OUTPUT_MAX = 2_000;

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

/**
 * Masks giveaway filenames in exam-thread activity labels (QA F3). The
 * generation/grading terminal keeps its theater — commands still read as
 * commands — but a label like `python3 tests/test_query.py solution.sql`
 * or a `.exercises/exam-<id>-key/` path would tell the exam-taker where the
 * reference solution and answer key live.
 */
export function maskExamArtifacts(label: string): string {
  return label
    .replace(/\bexam-[A-Za-z0-9-]*-key\b/g, 'exam-████')
    .replace(/\b(?:solutions?|answers?|answer[_-]key|rubrics?|expected)\.[A-Za-z0-9_.]+/gi, '████')
    .replace(/\b(?:solution|answer[_-]key|rubric)s?\//gi, '████/');
}

export class ThreadManager implements ExamThreadService, TrackThreadService {
  private readonly prisma: PrismaClient;
  private readonly client: AppServerClient;
  private readonly workspaces: WorkspaceManager;
  private readonly memory: Pick<MemoryPipeline, 'beforeTurn' | 'afterTurn'>;
  private readonly sink: ThreadEventSink;
  private readonly log: CodexLogger;
  private readonly turnTimeoutMs: number;
  private readonly dailyTurnQuota: number;

  /** codexThreadIds known to the CURRENT codex child (cleared on restart). */
  private readonly resumedThreads = new Set<string>();
  /** codexThreadId → unsubscribe for the event fan-in (one per thread). */
  private readonly subscriptions = new Map<string, () => void>();
  /**
   * Per-WORKSPACE turn serialization (userId → queue tail). Grading turns
   * made same-workspace concurrency real (Phase 2 carry-over b): two threads
   * of one user overlapping would double-emit commits from overlapping
   * sinceSha ranges, and one turn's checkpoint could sweep the other's writes.
   */
  private readonly turnQueues = new Map<string, Promise<unknown>>();
  /** Per-thread sequential ItemMirror writes (preserves createdAt ordering). */
  private readonly mirrorQueues = new Map<string, Promise<unknown>>();
  /** thread row id → the one in-flight turn (turns are serialized per workspace). */
  private readonly inFlight = new Map<string, InFlightTurn>();
  /** thread row id → waiter for the in-flight turn's outcome (matched by turn id). */
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  /** thread row id → codex turn id → outcome that arrived before the waiter knew its id. */
  private readonly bufferedOutcomes = new Map<string, Map<string, TurnOutcome>>();
  /** ensureThread races: one create per (user, mode, topic) key at a time. */
  private readonly pendingEnsures = new Map<string, Promise<EnsureThreadResult>>();
  /** thread/resume races: one resume per codex thread at a time. */
  private readonly pendingResumes = new Map<string, Promise<void>>();

  constructor(deps: ThreadManagerDeps) {
    this.prisma = deps.prisma;
    this.client = deps.client;
    this.workspaces = deps.workspaces;
    this.memory = deps.memory;
    this.sink = deps.sink;
    this.log = deps.logger ?? NOOP_LOGGER;
    this.turnTimeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.dailyTurnQuota = deps.dailyTurnQuota ?? 0;
  }

  /**
   * Finds the active Thread row for (user, mode, topic) or creates one:
   * ensureWorkspace → thread/start (cwd = workspace, mode instructions with a
   * fresh persisted sessionToken) → persist mapping. A newly created thread
   * immediately runs the auto-greeting turn (fire-and-forget through the
   * per-thread queue) so the learner never faces a blank chat.
   */
  async ensureThread(
    userId: string,
    mode: ThreadMode,
    opts: { topicSlug?: string | null } = {},
  ): Promise<EnsureThreadResult> {
    if (mode !== 'learn' && mode !== 'review') {
      throw new Error(
        `ThreadManager.ensureThread: mode "${mode}" is not creatable directly ` +
          '(exam threads are forked by ExamService)',
      );
    }
    const topicSlug = opts.topicSlug ?? null;
    const key = [userId, mode, topicSlug ?? ''].join('\u0000');
    const pending = this.pendingEnsures.get(key);
    if (pending) return pending;
    const promise = this.findOrCreate(userId, mode, topicSlug).finally(() =>
      this.pendingEnsures.delete(key),
    );
    this.pendingEnsures.set(key, promise);
    return promise;
  }

  /**
   * Runs non-turn workspace work behind the SAME per-user tail as turns.
   * Jobs passed here must never enqueue or await a turn: doing so would wait
   * on their own queue slot forever.
   */
  runExclusive<T>(userId: string, job: () => Promise<T>): Promise<T> {
    return this.enqueue(this.turnQueues, userId, job);
  }

  /** Always-new plan thread. TrackService owns the kickoff and reconciliation. */
  async createPlanThread(
    userId: string,
    opts: { trackSlug: string; intake: TrackIntake },
  ): Promise<Thread> {
    const workspace = await this.workspaces.ensureWorkspace(userId);
    const sessionToken = randomUUID();
    const needsProfile = !(await this.workspaces.hasCommittedProfile(userId));
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const developerInstructions = buildPlanInstructions({
      sessionToken,
      trackSlug: opts.trackSlug,
      intake: opts.intake,
      needsProfile,
      learnerName: user?.displayName ?? 'Learner',
    });
    const started = await this.client.startThread({
      cwd: workspace.path,
      developerInstructions,
    });
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: started.thread.id,
        mode: 'plan',
        trackSlug: opts.trackSlug,
        title: `Planning — ${opts.intake.subject}`,
        sessionToken,
      },
    });
    this.resumedThreads.add(thread.codexThreadId);
    this.attach(thread);
    return thread;
  }

  /** Always-new roadmap sitting; legacy find-or-create is never consulted. */
  async createTrackSession(
    userId: string,
    opts: { trackSlug: string; day: number; intent: 'teach' | 'revise' | 'mistakes' },
  ): Promise<Thread> {
    const context = await this.trackSessionContext(userId, opts);
    const workspace = await this.workspaces.ensureWorkspace(userId);
    const sessionToken = randomUUID();
    const developerInstructions = buildLearnInstructions({
      sessionToken,
      topicSlug: context.topicSlug,
      isSessionStart: true,
      trackSlug: opts.trackSlug,
      roadmapDay: opts.day,
      dayTitle: context.title,
      daySubtopics: context.subtopics,
      intent: opts.intent,
      ...(context.mistakesEvidence !== null ? { mistakesEvidence: context.mistakesEvidence } : {}),
    });
    const started = await this.client.startThread({
      cwd: workspace.path,
      developerInstructions,
    });
    const title =
      opts.intent === 'revise'
        ? `Day ${opts.day} — revisited`
        : opts.intent === 'mistakes'
          ? `Day ${opts.day} — fixing gaps`
          : `Day ${opts.day} — ${context.title}`;
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: started.thread.id,
        mode: 'learn',
        topicSlug: context.topicSlug,
        trackSlug: opts.trackSlug,
        roadmapDay: opts.day,
        intent: opts.intent,
        title,
        sessionToken,
      },
    });
    this.resumedThreads.add(thread.codexThreadId);
    this.attach(thread);
    void this.enqueueTurn(thread, GREETING_INPUT, 'system').catch((err: unknown) => {
      this.log.error({ err, threadId: thread.id }, 'track-session greeting turn failed');
      this.emitTurnEvent(thread, {
        type: 'turn.error',
        threadId: thread.id,
        message: 'The tutor could not open the session. Send a message to try again.',
        retryable: true,
      });
    });
    return thread;
  }

  /**
   * Forks the learner's tutor thread into an EXAM thread (plans/01 §4.2 —
   * the exam agent inherits full pedagogical context, then diverges).
   * ExamService creates the Exam row (id = opts.examId) right after, and the
   * fork's FIRST turn re-resumes AND INJECTS instructions rebuilt from that
   * row (see resume()). The injection is mandatory: codex 0.144.4 drops
   * `developerInstructions` on thread/fork AND thread/resume — the fork runs
   * on the parent's transcript instructions (observed live in the Phase 4
   * E2E, twice: the model kept tutoring with the PARENT's session token).
   * We still pass them at fork for forward-compat, but the thread
   * deliberately stays out of resumedThreads so ensureResumed delivers the
   * real exam template before any turn runs. No auto-greeting: the
   * generation turn is the fork's first turn.
   */
  async forkForExam(parent: Thread, opts: ExamForkOptions): Promise<Thread> {
    await this.ensureParentTurnHistory(parent);
    const workspace = await this.workspaces.ensureWorkspace(parent.userId);
    const sessionToken = randomUUID();
    const forked = await this.client.forkThread({
      threadId: parent.codexThreadId,
      cwd: workspace.path,
      developerInstructions: buildExamGenerateInstructions({
        sessionToken,
        examId: opts.examId,
        trackSlug: opts.trackSlug,
        durationMin: opts.durationMin,
        targeting: opts.targeting,
      }),
    });
    const thread = await this.prisma.thread.create({
      data: {
        userId: parent.userId,
        codexThreadId: forked.thread.id,
        mode: 'exam',
        trackSlug: opts.trackSlug,
        title: `Mock exam — ${opts.trackSlug}`,
        forkedFromId: parent.id,
        sessionToken,
      },
    });
    this.attach(thread);
    this.log.info(
      {
        threadId: thread.id,
        codexThreadId: thread.codexThreadId,
        parentThreadId: parent.id,
        examId: opts.examId,
        trackSlug: opts.trackSlug,
      },
      'exam thread forked',
    );
    return thread;
  }

  invalidateInstructions(thread: Thread): void {
    this.resumedThreads.delete(thread.codexThreadId);
  }

  /**
   * codex only writes a thread's rollout once a turn has run, and
   * `thread/fork` reads the parent's rollout — forking a turnless thread
   * fails with "no rollout found" (observed live: a fresh/seeded user's
   * first exam, whose learn-thread greeting hadn't run yet). Guarantee the
   * parent has at least one completed turn: wait out anything queued (the
   * fire-and-forget greeting), then run an awaited greeting turn if the
   * thread is still turnless. Completed turns always leave agent-role
   * ItemMirror rows, so their presence is the persistent "has a rollout"
   * signal.
   */
  private async ensureParentTurnHistory(parent: Thread): Promise<void> {
    const hasTurnHistory = async (): Promise<boolean> =>
      (await this.prisma.itemMirror.count({ where: { threadId: parent.id, role: 'agent' } })) > 0;
    if (await hasTurnHistory()) return;
    await this.turnQueues.get(parent.userId)?.catch(() => {});
    if (await hasTurnHistory()) return;
    this.log.info(
      { threadId: parent.id },
      'exam fork parent has no completed turn — running its greeting first',
    );
    await this.enqueueTurn(parent, GREETING_INPUT, 'system');
    if (!(await hasTurnHistory())) {
      throw new Error(
        `exam fork parent ${parent.id} still has no completed turn (its greeting failed)`,
      );
    }
  }

  /**
   * Queues one turn on the thread: context envelope + user text →
   * turn/start → stream events to the gateway + ItemMirror → on completion
   * run the MemoryPipeline and emit turn.completed / turn.error. Resolves
   * when the turn has fully settled (E2E and tests await it; the gateway
   * fires-and-forgets with a turn.error catch).
   */
  startTurn(thread: Thread, userText: string): Promise<void> {
    return this.enqueueTurn(thread, userText, 'user');
  }

  startSystemTurn(thread: Thread, text: string, opts?: { caption?: string }): Promise<void> {
    return this.enqueueTurn(thread, text, 'system', opts?.caption ?? null);
  }

  /** Interrupts the thread's in-flight turn, if any (no-op otherwise). */
  async interrupt(threadId: string): Promise<void> {
    const inflight = this.inFlight.get(threadId);
    if (!inflight) return;
    await this.client.interruptTurn(inflight.codexThreadId, inflight.turnId);
  }

  turnInFlight(threadId: string): boolean {
    return this.inFlight.has(threadId);
  }

  inFlightThreads(userId: string): string[] {
    const ids: string[] = [];
    for (const [threadId, turn] of this.inFlight) {
      if (turn.userId === userId) ids.push(threadId);
    }
    return ids;
  }

  /**
   * After a codex auto-restart (client.onRestarted): the new child knows no
   * threads, so re-resume every thread this process has touched. Emits
   * nothing — in-flight turns were already failed via synthetic turnAborted.
   */
  async resumeAll(): Promise<void> {
    this.resumedThreads.clear();
    const codexThreadIds = [...this.subscriptions.keys()];
    if (codexThreadIds.length === 0) return;
    const threads = await this.prisma.thread.findMany({
      where: { codexThreadId: { in: codexThreadIds }, status: 'active' },
    });
    for (const thread of threads) {
      try {
        await this.ensureResumed(thread);
      } catch (err) {
        this.log.error({ err, threadId: thread.id }, 'resumeAll: thread/resume failed');
      }
    }
    this.log.info({ resumed: threads.length }, 'threads re-resumed after codex restart');
  }

  /** Drops all event subscriptions (shutdown/test teardown). */
  close(): void {
    for (const unsubscribe of this.subscriptions.values()) unsubscribe();
    this.subscriptions.clear();
  }

  // ------------------------------------------------------------------ ensure

  private async findOrCreate(
    userId: string,
    mode: ThreadMode,
    topicSlug: string | null,
  ): Promise<EnsureThreadResult> {
    const existing = await this.prisma.thread.findFirst({
      where: { userId, mode, topicSlug, roadmapDay: null, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      await this.ensureResumed(existing);
      return { thread: existing, created: false };
    }

    const workspace = await this.workspaces.ensureWorkspace(userId);
    const sessionToken = randomUUID();
    const onboarded = await this.workspaces.hasCommittedProfile(userId);
    const developerInstructions = await this.instructionsFor({
      userId,
      mode,
      topicSlug,
      sessionToken,
      onboarded,
    });
    const started = await this.client.startThread({
      cwd: workspace.path,
      developerInstructions,
    });
    const thread = await this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: started.thread.id,
        mode,
        topicSlug,
        title: this.titleFor(mode, topicSlug, onboarded),
        sessionToken,
      },
    });
    this.resumedThreads.add(thread.codexThreadId);
    this.attach(thread);
    this.log.info(
      { threadId: thread.id, codexThreadId: thread.codexThreadId, mode, topicSlug, onboarded },
      'thread created',
    );

    // Auto-greeting: queued like any turn; failures surface as turn.error so
    // the UI shows a retryable state instead of a silent blank chat.
    void this.enqueueTurn(thread, GREETING_INPUT, 'system').catch((err: unknown) => {
      this.log.error({ err, threadId: thread.id }, 'greeting turn failed');
      this.emitTurnEvent(thread, {
        type: 'turn.error',
        threadId: thread.id,
        message: 'The tutor could not open the session. Send a message to try again.',
        retryable: true,
      });
    });

    return { thread, created: true };
  }

  private async instructionsFor(opts: {
    userId: string;
    mode: ThreadMode;
    topicSlug: string | null;
    trackSlug?: string | null;
    roadmapDay?: number | null;
    intent?: string | null;
    sessionToken: string;
    onboarded: boolean;
    /** Thread ROW id — required to rebuild exam instructions from the Exam row. */
    threadRowId?: string;
  }): Promise<string> {
    if (opts.mode === 'exam') {
      return this.examInstructions(opts.threadRowId, opts.sessionToken);
    }
    if (opts.mode === 'plan') {
      if (!opts.trackSlug) throw new Error('plan instructions need a track slug');
      const track = await this.prisma.track.findUnique({
        where: { userId_slug: { userId: opts.userId, slug: opts.trackSlug } },
      });
      if (!track) throw new Error(`plan thread has no Track row for ${opts.trackSlug}`);
      const intake = trackIntakeSchema.parse(track.intake);
      const user = await this.prisma.user.findUnique({ where: { id: opts.userId } });
      return buildPlanInstructions({
        sessionToken: opts.sessionToken,
        trackSlug: opts.trackSlug,
        intake,
        needsProfile: !opts.onboarded,
        learnerName: user?.displayName ?? 'Learner',
      });
    }
    // Review threads exist only for learners with an SRS queue (ReviewService
    // guards on due items), so the onboarding branch never applies to them.
    if (opts.mode === 'review') {
      return buildReviewInstructions({ sessionToken: opts.sessionToken });
    }
    if (!opts.onboarded) {
      // The account name keeps profile.md's required `name:` from coming out
      // null when the learner never states one (E2E prompt-bug finding).
      const user = await this.prisma.user.findUnique({ where: { id: opts.userId } });
      return buildOnboardingInstructions({
        sessionToken: opts.sessionToken,
        ...(user ? { learnerName: user.displayName } : {}),
      });
    }
    return buildLearnInstructions({
      sessionToken: opts.sessionToken,
      topicSlug: opts.topicSlug,
      isSessionStart: true,
    });
  }

  /**
   * Rebuilds an exam thread's developerInstructions from its Exam row: the
   * generation template until the learner submits, the grading template from
   * `submitted` on (ExamService flips the status BEFORE invalidating, so the
   * rotation-triggered resume always sees the new phase).
   */
  private async examInstructions(
    threadRowId: string | undefined,
    sessionToken: string,
  ): Promise<string> {
    if (threadRowId === undefined) {
      throw new Error('exam instructions need the thread row id');
    }
    const exam = await this.prisma.exam.findFirst({
      where: { threadId: threadRowId },
      orderBy: { createdAt: 'desc' },
    });
    if (exam === null) {
      // Only reachable in the tiny window between thread/fork and the Exam
      // row insert (or after a crash inside it) — fail the resume loudly.
      throw new Error(`exam thread ${threadRowId} has no Exam row`);
    }
    const config = parseExamConfig(exam.config);
    if (exam.status === 'submitted' || exam.status === 'graded') {
      return buildExamGradeInstructions({
        sessionToken,
        examId: exam.id,
        trackSlug: exam.trackSlug,
        ...(config.readinessBefore !== undefined
          ? { readinessBefore: config.readinessBefore }
          : {}),
      });
    }
    return buildExamGenerateInstructions({
      sessionToken,
      examId: exam.id,
      trackSlug: exam.trackSlug,
      durationMin: config.durationMin,
      targeting: config.targeting,
    });
  }

  /** Resolves the versioned roadmap context and bounded real mistake evidence. */
  private async trackSessionContext(
    userId: string,
    opts: { trackSlug: string; day: number; intent: 'teach' | 'revise' | 'mistakes' },
  ): Promise<{
    title: string;
    topicSlug: string;
    subtopics: string[];
    mistakesEvidence: string | null;
  }> {
    const model = await this.workspaces.readLearnerModel(userId);
    const roadmap = model.roadmaps.find((candidate) => candidate.track === opts.trackSlug);
    const day = roadmap?.days.find((candidate) => candidate.day === opts.day);
    const topicSlug = day?.topics[0]?.topic;
    if (!day || !topicSlug) {
      throw new Error(`roadmap day ${opts.day} does not exist for ${opts.trackSlug}`);
    }
    if (opts.intent !== 'mistakes') {
      return { title: day.title, topicSlug, subtopics: day.subtopics, mistakesEvidence: null };
    }

    const concepts = new Set(
      day.topics.flatMap((topic) =>
        topic.concepts.flatMap((concept) => [concept, `${topic.topic}/${concept}`]),
      ),
    );
    const evidence: string[] = [];

    // Misconceptions are markdown, not database rows. Keep only blocks that
    // name a concept from this day; never dump an unrelated learner history.
    for (const topic of new Set(day.topics.map((entry) => entry.topic))) {
      try {
        const raw = await fs.readFile(
          path.join(this.workspaces.pathFor(userId), `topics/${topic}/misconceptions.md`),
          'utf8',
        );
        const blocks = raw.split(/(?=^##\s)/m);
        for (const block of blocks) {
          if (
            /^##\s*\[OPEN\]/m.test(block) &&
            [...concepts].some((concept) => block.includes(concept))
          ) {
            evidence.push(`Open misconception: ${clip(block, 420)}`);
          }
        }
      } catch {
        // Missing misconception files are normal for new topics.
      }
    }

    // Exercise.concepts is opaque SQLite Json: fetch rows, then filter in JS.
    const exercises = await this.prisma.exercise.findMany({
      where: { userId },
      include: { attempts: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' },
    });
    for (const exercise of exercises) {
      const refs = Array.isArray(exercise.concepts)
        ? exercise.concepts.filter((value): value is string => typeof value === 'string')
        : [];
      if (!refs.some((concept) => concepts.has(concept))) continue;
      const attempt = exercise.attempts.find(
        (candidate) => candidate.verdict === 'failed' || candidate.verdict === 'error',
      );
      if (!attempt) continue;
      evidence.push(
        `Exercise ${exercise.slug} (${exercise.title}): ${attempt.verdict}; ` +
          clip(attempt.feedback ?? 'no feedback recorded', 260),
      );
    }

    try {
      const sessionsDir = path.join(this.workspaces.pathFor(userId), 'sessions');
      for (const file of await fs.readdir(sessionsDir)) {
        if (!file.endsWith('.md')) continue;
        try {
          const raw = await fs.readFile(path.join(sessionsDir, file), 'utf8');
          const parsed = parseFrontmatterFile(sessionLogFrontmatterSchema, raw);
          if (
            parsed.frontmatter.track === opts.trackSlug &&
            parsed.frontmatter.roadmap_day === opts.day &&
            parsed.frontmatter.next_time
          ) {
            evidence.push(`Session next-time pointer: ${clip(parsed.frontmatter.next_time, 260)}`);
          }
        } catch {
          // Invalid logs are surfaced by the normal repair path; skip as evidence.
        }
      }
    } catch {
      // A new workspace may have no session logs.
    }

    const bounded = evidence.join('\n').slice(0, 2_400);
    return {
      title: day.title,
      topicSlug,
      subtopics: day.subtopics,
      mistakesEvidence: bounded || 'No recorded mistake evidence; begin with retrieval.',
    };
  }

  private titleFor(mode: ThreadMode, topicSlug: string | null, onboarded: boolean): string {
    if (mode === 'review') return 'Review session';
    if (!onboarded) return 'Getting to know you';
    return topicSlug ? `Learning ${topicSlug}` : 'Learning session';
  }

  /**
   * Makes sure the CURRENT codex child knows this thread. Instructions are
   * rebuilt from current state (same persisted sessionToken) — this is where
   * a finished-onboarding learner's thread rotates to learn-mode instructions
   * (plans/03 §3.1 re-resume rule).
   */
  private async ensureResumed(thread: Thread): Promise<void> {
    this.attach(thread);
    if (this.resumedThreads.has(thread.codexThreadId)) return;
    const pending = this.pendingResumes.get(thread.codexThreadId);
    if (pending) return pending;
    const promise = this.resume(thread).finally(() =>
      this.pendingResumes.delete(thread.codexThreadId),
    );
    this.pendingResumes.set(thread.codexThreadId, promise);
    return promise;
  }

  private async resume(thread: Thread): Promise<void> {
    const workspace = await this.workspaces.ensureWorkspace(thread.userId);
    const onboarded = await this.workspaces.hasCommittedProfile(thread.userId);
    const developerInstructions = await this.instructionsFor({
      userId: thread.userId,
      mode: thread.mode as ThreadMode,
      topicSlug: thread.topicSlug,
      trackSlug: thread.trackSlug,
      roadmapDay: thread.roadmapDay,
      intent: thread.intent,
      sessionToken: thread.sessionToken,
      onboarded,
      threadRowId: thread.id,
    });
    await this.client.resumeThread({
      threadId: thread.codexThreadId,
      cwd: workspace.path,
      developerInstructions,
    });
    // codex 0.144.4 DROPS developerInstructions on thread/resume (and fork):
    // instructions only ever reach the model as the developer message that
    // thread/start writes into the transcript. An exam thread is a fork, so
    // its transcript carries the PARENT tutor's instructions (and the tutor's
    // session token) — inject the current-phase exam block as a developer
    // message instead; a later injection supersedes an earlier one, and
    // injected items persist in the rollout across restarts (all verified
    // live — PROTOCOL_NOTES Phase 4 addendum). Learn/review/onboarding
    // threads never need this: their instructions rode thread/start.
    if (thread.mode === 'exam') {
      await this.client.injectItems({
        threadId: thread.codexThreadId,
        items: [
          {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: EXAM_INJECT_PREAMBLE + developerInstructions }],
          },
        ],
      });
    }
    this.resumedThreads.add(thread.codexThreadId);
    this.log.info({ threadId: thread.id, codexThreadId: thread.codexThreadId }, 'thread resumed');
  }

  // ------------------------------------------------------------------- turns

  private enqueueTurn(
    thread: Thread,
    text: string,
    role: 'user' | 'system',
    caption: string | null = null,
  ): Promise<void> {
    // Keyed by USER: all of a workspace's threads share one turn at a time.
    return this.enqueue(this.turnQueues, thread.userId, () =>
      this.runTurn(thread, text, role, caption),
    );
  }

  /**
   * Daily quota gate + bookkeeping for USER turns (plans/08 §5). Runs inside
   * the per-user turn queue, so check-then-record is race-free. A refused
   * turn leaves no trace (no mirror row, no lastActiveAt bump): the manager
   * emits the terminal turn.error itself, then rejects with the typed error.
   */
  private async enforceDailyQuota(thread: Thread): Promise<void> {
    if (this.dailyTurnQuota <= 0) return;
    const user = await this.prisma.user.findUnique({
      where: { id: thread.userId },
      select: { timezone: true },
    });
    const timezone = user?.timezone ?? 'UTC';
    const now = new Date();
    const today = localDate(now, timezone);
    // Same local-day bucketing as the dashboard: pull the recent window and
    // compare calendar days in the user's timezone (cheap — quota-sized).
    const recent = await this.prisma.activityEvent.findMany({
      where: {
        userId: thread.userId,
        kind: TURN_START_EVENT,
        at: { gte: new Date(now.getTime() - QUOTA_LOOKBACK_MS) },
      },
      select: { at: true },
    });
    const startsToday = recent.filter((event) => localDate(event.at, timezone) === today).length;
    if (startsToday >= this.dailyTurnQuota) {
      this.log.warn(
        { threadId: thread.id, userId: thread.userId, quota: this.dailyTurnQuota },
        'daily turn quota reached — refusing user turn',
      );
      this.emitTurnEvent(thread, {
        type: 'turn.error',
        threadId: thread.id,
        message: DAILY_QUOTA_MESSAGE,
        retryable: false,
      });
      throw new DailyTurnQuotaError(this.dailyTurnQuota);
    }
    // Recorded before dispatch: a start that later fails still spent a start.
    await this.prisma.activityEvent.create({
      data: {
        userId: thread.userId,
        kind: TURN_START_EVENT,
        meta: { threadId: thread.id, mode: thread.mode },
      },
    });
  }

  private async runTurn(
    thread: Thread,
    text: string,
    role: 'user' | 'system',
    caption: string | null = null,
  ): Promise<void> {
    if (role === 'user') await this.enforceDailyQuota(thread);
    await this.ensureResumed(thread);

    const model = await this.workspaces.readLearnerModel(thread.userId);
    const digest = formatStateDigest(model);
    // Review threads get the FULL due list each turn (the digest previews only
    // 3) — it shrinks live as the agent updates srs/queue.yaml between turns.
    const notes = thread.mode === 'review' ? formatReviewDueNotes(model, new Date()) : undefined;
    const input =
      buildContextEnvelope(digest, {
        needsRepair: model.needsRepair,
        ...(notes !== undefined ? { notes } : {}),
      }) + text;
    const sinceSha = await this.memory.beforeTurn(thread.userId);

    // The mirror stores the RAW text (the envelope is wire-only context);
    // system rows also carry the short chat-facing caption when given.
    await this.mirrorWrite(thread.id, {
      threadId: thread.id,
      role,
      kind: 'message',
      payload: caption === null ? { text } : { text, caption },
    });
    await this.prisma.thread.update({
      where: { id: thread.id },
      data: { lastActiveAt: new Date() },
    });

    // Waiter registered before turn/start: completion events can never race
    // it. It settles ONLY on outcomes matching its own turn id — a previous
    // turn completing late (after the fail-safe already gave up on it) must
    // not settle this one (Phase 1 carry-over c).
    let timeout: NodeJS.Timeout | null = null;
    let waiter!: TurnWaiter;
    const completion = new Promise<TurnOutcome>((resolve) => {
      waiter = { expectedTurnId: null, resolve };
      this.turnWaiters.set(thread.id, waiter);
      timeout = setTimeout(() => {
        resolve({
          kind: 'aborted',
          message: `turn exceeded the ${this.turnTimeoutMs}ms fail-safe ceiling`,
        });
      }, this.turnTimeoutMs);
      timeout.unref?.();
    });

    let turnId: string;
    try {
      // The memory skill has the agent `git commit` its own learning events,
      // but workspace-write marks the workspace's top-level .git read-only
      // (commits die on .git/index.lock EPERM) — grant it back explicitly.
      const response = await this.client.startTurn(thread.codexThreadId, input, {
        writableRoots: [path.join(this.workspaces.pathFor(thread.userId), '.git')],
      });
      turnId = response.turn.id;
    } catch (err) {
      this.turnWaiters.delete(thread.id);
      this.bufferedOutcomes.delete(thread.id);
      if (timeout !== null) clearTimeout(timeout);
      throw err;
    }
    waiter.expectedTurnId = turnId;
    // A very fast turn can complete while turn/start's response is still in
    // this thread's microtask queue — consume anything buffered meanwhile.
    const buffered = this.bufferedOutcomes.get(thread.id)?.get(turnId);
    this.bufferedOutcomes.delete(thread.id);
    if (buffered !== undefined) waiter.resolve(buffered);
    this.inFlight.set(thread.id, {
      turnId,
      userId: thread.userId,
      codexThreadId: thread.codexThreadId,
    });
    this.log.info({ threadId: thread.id, turnId, role }, 'turn dispatched');

    const outcome = await completion;
    if (timeout !== null) clearTimeout(timeout);
    this.turnWaiters.delete(thread.id);
    this.bufferedOutcomes.delete(thread.id);
    this.inFlight.delete(thread.id);
    // Queued ItemMirror writes land before the pipeline + completion events —
    // clients refetch items when a turn settles.
    await this.mirrorQueues.get(thread.id);

    if (outcome.kind === 'aborted') {
      // Synthetic abort (child died / fail-safe): no MemoryPipeline — the next
      // completed turn's dirty-checkpoint sweep picks up any partial writes.
      this.log.warn({ threadId: thread.id, turnId, message: outcome.message }, 'turn aborted');
      this.emitTurnEvent(thread, {
        type: 'turn.error',
        threadId: thread.id,
        message: 'The tutor lost its train of thought (backend restarted). Try again.',
        retryable: true,
      });
      return;
    }

    try {
      const commits = await this.memory.afterTurn({
        userId: thread.userId,
        threadId: thread.id,
        topicSlug: thread.topicSlug,
        sinceSha,
      });
      // The pipeline already emitted to the user socket; thread-socket
      // consumers (commit toasts) get their copy here.
      for (const commit of commits) {
        this.sink.emitToThread(thread.id, { type: 'memory.commit', commit });
      }
    } catch (err) {
      this.log.error({ err, threadId: thread.id, turnId }, 'memory pipeline failed after turn');
    }

    if (outcome.status === 'failed') {
      this.emitTurnEvent(thread, {
        type: 'turn.error',
        threadId: thread.id,
        message: outcome.errorMessage ?? 'The turn failed. Try again.',
        retryable: true,
      });
    } else {
      // "completed" and user-initiated "interrupted" both settle the UI.
      this.emitTurnEvent(thread, { type: 'turn.completed', threadId: thread.id });
    }
  }

  // ------------------------------------------------------------ event fan-in

  private attach(thread: Thread): void {
    if (this.subscriptions.has(thread.codexThreadId)) return;
    const unsubscribe = this.client.onThreadEvent(thread.codexThreadId, (event) => {
      try {
        this.handleThreadEvent(thread, event);
      } catch (err) {
        this.log.error(
          { err, threadId: thread.id, type: event.type },
          'thread event handler threw',
        );
      }
    });
    this.subscriptions.set(thread.codexThreadId, unsubscribe);
  }

  private handleThreadEvent(thread: Thread, event: ThreadEvent): void {
    switch (event.type) {
      case 'turnStarted':
        this.emitTurnEvent(thread, { type: 'turn.started', threadId: thread.id });
        return;
      case 'agentMessageDelta':
        this.sink.emitToThread(thread.id, {
          type: 'message.delta',
          itemId: event.itemId,
          text: event.delta,
        });
        return;
      case 'reasoningSummaryDelta':
      case 'reasoningTextDelta':
        this.sink.emitToThread(thread.id, { type: 'reasoning.delta', text: event.delta });
        return;
      case 'itemStarted': {
        const activity = activityFor(event.item, thread.mode === 'exam');
        if (activity) {
          this.sink.emitToThread(thread.id, { ...activity, type: 'activity', status: 'started' });
        }
        return;
      }
      case 'itemCompleted':
        this.handleItemCompleted(thread, event.item);
        return;
      case 'turnCompleted':
        this.settleTurn(thread, event.turn.id, {
          kind: 'completed',
          status: event.turn.status,
          errorMessage: event.turn.error?.message ?? null,
        });
        return;
      case 'turnAborted':
        this.settleTurn(thread, event.turnId, { kind: 'aborted', message: event.error.message });
        return;
      default:
        return; // status/tokenUsage/plan/diff/raw — nothing to surface yet
    }
  }

  /**
   * Routes a turn outcome to the thread's waiter iff the turn ids match;
   * buffers it when the waiter doesn't know its id yet (turn/start response
   * still in flight); drops it as stale otherwise (carry-over c: a late
   * completion must never settle a newer queued turn).
   */
  private settleTurn(thread: Thread, turnId: string, outcome: TurnOutcome): void {
    const waiter = this.turnWaiters.get(thread.id);
    if (waiter !== undefined && waiter.expectedTurnId === turnId) {
      waiter.resolve(outcome);
      return;
    }
    if (waiter !== undefined && waiter.expectedTurnId === null) {
      let byTurn = this.bufferedOutcomes.get(thread.id);
      if (byTurn === undefined) {
        byTurn = new Map();
        this.bufferedOutcomes.set(thread.id, byTurn);
      }
      byTurn.set(turnId, outcome);
      return;
    }
    this.log.warn(
      { threadId: thread.id, turnId, outcome: outcome.kind },
      waiter === undefined
        ? 'turn settled with no waiter — ignoring'
        : 'stale turn completion (fail-safe already gave up on it) — ignoring',
    );
  }

  private handleItemCompleted(thread: Thread, item: CodexItem): void {
    const activity = activityFor(item, thread.mode === 'exam');
    if (activity) {
      this.sink.emitToThread(thread.id, {
        ...activity,
        type: 'activity',
        status: itemFailed(item) ? 'failed' : 'completed',
      });
    }

    // Exam integrity: the examiner's shell traffic (heredoc-written hidden
    // tests, test-run output) must not sit readable in ItemMirror mid-exam —
    // GET /api/threads/:id/items serves it to the exam-taker. Mirror exam
    // exec rows with only the 80-char label the live activity chip already
    // showed. (The web never renders mirrored exec rows; this is belt and
    // suspenders for the raw API.)
    const row = mirrorRowFor(item, { redactExecDetail: thread.mode === 'exam' });
    if (!row) return;
    void this.enqueue(this.mirrorQueues, thread.id, async () => {
      await this.mirrorWrite(thread.id, {
        id: item.id,
        threadId: thread.id,
        codexItemId: item.id,
        ...row,
      });
      // message.completed AFTER the mirror write: a client that refetches on
      // this event finds the row (id = codex item id, so it dedupes).
      if (item.type === 'agentMessage') {
        this.sink.emitToThread(thread.id, {
          type: 'message.completed',
          itemId: item.id,
          text: item.text,
        });
      }
    }).catch((err: unknown) => {
      this.log.error({ err, threadId: thread.id, itemId: item.id }, 'ItemMirror write failed');
    });
  }

  private emitTurnEvent(thread: Thread, event: WsEvent): void {
    // Turn lifecycle goes to the thread socket AND the user socket (plans/03 §7).
    this.sink.emitToThread(thread.id, event);
    this.sink.emitToUser(thread.userId, event);
  }

  // -------------------------------------------------------------- plumbing

  private async mirrorWrite(
    threadId: string,
    data: {
      id?: string;
      threadId: string;
      codexItemId?: string;
      role: string;
      kind: string;
      payload: Prisma.InputJsonValue;
    },
  ): Promise<void> {
    if (data.id === undefined) {
      await this.prisma.itemMirror.create({ data });
      return;
    }
    // Idempotent for replayed item/completed events (e.g. around restarts).
    await this.prisma.itemMirror.upsert({
      where: { id: data.id },
      create: data,
      update: { payload: data.payload },
    });
  }

  private enqueue<T>(
    queues: Map<string, Promise<unknown>>,
    key: string,
    job: () => Promise<T>,
  ): Promise<T> {
    const tail = queues.get(key) ?? Promise.resolve();
    const next = tail.then(job, job);
    queues.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }
}

/**
 * Activity-chip mapping for exec/tool/file items (plans/03 §7 `activity`).
 * Exam threads mask answer-key filenames out of exec labels (QA F3) — the
 * SAME masked label is what the exam exec ItemMirror row carries, so no
 * surface ever shows more than the live chip did.
 */
function activityFor(
  item: CodexItem,
  exam = false,
): { kind: 'exec' | 'tool'; label: string } | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        kind: 'exec',
        label: clip(exam ? maskExamArtifacts(item.command) : item.command, ACTIVITY_LABEL_MAX),
      };
    case 'mcpToolCall':
      return { kind: 'tool', label: clip(item.tool, ACTIVITY_LABEL_MAX) };
    case 'fileChange':
      return { kind: 'exec', label: 'updating memory files' };
    default:
      return null;
  }
}

function itemFailed(item: CodexItem): boolean {
  switch (item.type) {
    case 'commandExecution':
      return item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0);
    case 'mcpToolCall':
      return item.status === 'failed';
    case 'fileChange':
      return item.status === 'failed';
    default:
      return false;
  }
}

/**
 * ItemMirror rows for completed items (plans/02 §5 kinds). Agent messages use
 * the CODEX item id as the row id so streamed WS items and refetched history
 * dedupe by the same id in the web client. userMessage items are skipped —
 * the manager mirrors the raw user text itself (the codex item would contain
 * the context envelope).
 */
function mirrorRowFor(
  item: CodexItem,
  opts: { redactExecDetail?: boolean } = {},
): { role: string; kind: string; payload: Prisma.InputJsonValue } | null {
  switch (item.type) {
    case 'agentMessage':
      return {
        role: 'agent',
        kind: 'message',
        payload: { text: item.text, phase: item.phase ?? null },
      };
    case 'reasoning':
      if (item.summary.length === 0) return null;
      return { role: 'agent', kind: 'reasoning', payload: { summary: item.summary } };
    case 'commandExecution':
      return {
        role: 'agent',
        kind: 'exec',
        payload: opts.redactExecDetail
          ? {
              // Exactly the (masked) live activity-chip label — never more.
              command: clip(maskExamArtifacts(item.command), ACTIVITY_LABEL_MAX),
              status: item.status,
              exitCode: item.exitCode,
              durationMs: item.durationMs,
              aggregatedOutput: null,
            }
          : {
              command: item.command,
              status: item.status,
              exitCode: item.exitCode,
              durationMs: item.durationMs,
              aggregatedOutput:
                item.aggregatedOutput === null
                  ? null
                  : clip(item.aggregatedOutput, EXEC_OUTPUT_MAX),
            },
      };
    case 'mcpToolCall':
      return {
        role: 'agent',
        kind: 'tool_call',
        payload: { server: item.server, tool: item.tool, status: item.status },
      };
    default:
      return null;
  }
}
