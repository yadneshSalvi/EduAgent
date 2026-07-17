/**
 * ExamService (plans/03 §3.5): the state machine over `Exam.status`
 * (draft → ready → in_progress → submitted → graded) and the two
 * agent-facing beats around it:
 *
 * - create: insert the draft row, FORK the learner's tutor thread
 *   (`thread/fork`, plans/01 §4.2 — the examiner inherits full pedagogical
 *   context) with exam-generate developerInstructions, start the generation
 *   turn; the relay's ui_create_exam handler fills `questions` → `ready`.
 * - submit: persist answers, write coding answers into their gitignored exam
 *   workdirs, rotate the fork onto exam-grade instructions (thread/resume),
 *   start the grading turn; the relay's ui_grade_exam handler persists the
 *   result → `graded`.
 *
 * The deadline is SERVER-AUTHORITATIVE: `startedAt + durationMin` with a 30s
 * enforcement grace. Autosaves past it reject; a sweep auto-submits expired
 * `in_progress` exams with their last autosaved answers.
 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Exam, Prisma, PrismaClient } from '@prisma/client';
import { examQuestionsSchema, type ExamAnswers, type ExamQuestions } from '@eduagent/shared';
import { submissionRelPath } from '../api/exercises.js';
import {
  buildExamGradingTurn,
  EXAM_GENERATE_KICKOFF_INPUT,
} from '../prompts/index.js';
import type { ExamThreadService, ThreadEventSink } from '../threads/index.js';
import type { WorkspaceLogger, WorkspaceManager } from '../workspace/index.js';
import type { DashboardService } from './DashboardService.js';
import {
  EXAM_IGNORE_PATTERN,
  examDeadline,
  examExpired,
  parseExamConfig,
  type ExamConfig,
  type ExamTarget,
} from './exam-config.js';

/** Thrown by create() for a track the learner model doesn't know — routes map to 404. */
export class UnknownTrackError extends Error {
  constructor(trackSlug: string) {
    super(`No track "${trackSlug}" exists in this learner's memory.`);
    this.name = 'UnknownTrackError';
  }
}

/** Thrown on a transition the state machine forbids — routes map to 409. */
export class ExamStateError extends Error {
  constructor(
    message: string,
    readonly status: string,
  ) {
    super(message);
    this.name = 'ExamStateError';
  }
}

/** Thrown by autosave() past deadline+grace — routes map to 409 deadline_passed. */
export class DeadlinePassedError extends Error {
  constructor() {
    super('The exam deadline has passed; answers are no longer accepted.');
    this.name = 'DeadlinePassedError';
  }
}

/** Thrown when the memory fork itself fails — routes map to 503 fork_failed. */
export class ExamForkError extends Error {
  constructor() {
    super('The examiner could not fork your memory. Give it a moment and start the exam again.');
    this.name = 'ExamForkError';
  }
}

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export interface ExamServiceDeps {
  prisma: PrismaClient;
  workspaces: WorkspaceManager;
  threads: ExamThreadService;
  dashboard: Pick<DashboardService, 'get'>;
  sink: ThreadEventSink;
  logger?: WorkspaceLogger;
}

export class ExamService {
  private readonly prisma: PrismaClient;
  private readonly workspaces: WorkspaceManager;
  private readonly threads: ExamThreadService;
  private readonly dashboard: Pick<DashboardService, 'get'>;
  private readonly sink: ThreadEventSink;
  private readonly logger: WorkspaceLogger;
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweepInFlight: Promise<void> | null = null;

  constructor(deps: ExamServiceDeps) {
    this.prisma = deps.prisma;
    this.workspaces = deps.workspaces;
    this.threads = deps.threads;
    this.dashboard = deps.dashboard;
    this.sink = deps.sink;
    this.logger = deps.logger ?? noopLogger;
  }

  // ------------------------------------------------------------------ create

  /**
   * Creates a draft exam and kicks off generation (fire-and-forget like the
   * review kickoff — the browser follows via `exam.created` / `turn.error`
   * on the user socket and by polling GET /api/exams/:id).
   */
  async create(
    userId: string,
    opts: { trackSlug: string; durationMin: number },
  ): Promise<{ examId: string; status: 'draft' }> {
    const targeting = await this.targetingFor(userId, opts.trackSlug);

    // Exam workdirs must be invisible to git BEFORE any test file exists:
    // the post-turn safety net commits anything visibly dirty, and committed
    // objects are learner-readable (plans/06 Phase 4 task 5). New workspaces
    // carry the pattern in the template .gitignore; this covers older ones.
    await this.ensureExamIgnoreRule(userId);

    const parent =
      (await this.prisma.thread.findFirst({
        where: { userId, mode: 'learn', status: 'active' },
        orderBy: { lastActiveAt: 'desc' },
      })) ?? (await this.threads.ensureThread(userId, 'learn')).thread;

    const examId = randomUUID();
    const config: ExamConfig = { durationMin: opts.durationMin, targeting };
    let thread;
    try {
      thread = await this.threads.forkForExam(parent, {
        examId,
        trackSlug: opts.trackSlug,
        durationMin: opts.durationMin,
        targeting,
      });
    } catch (err) {
      // Protocol-level fork failures (codex down, rollout issues) are
      // transient infrastructure, not caller mistakes — surface a clean 503
      // instead of a raw 500 (no Exam row exists yet, so nothing dangles).
      this.logger.warn({ err, userId, trackSlug: opts.trackSlug }, 'exam thread fork failed');
      throw new ExamForkError();
    }
    await this.prisma.exam.create({
      data: {
        id: examId,
        userId,
        threadId: thread.id,
        trackSlug: opts.trackSlug,
        config: config as Prisma.InputJsonValue,
        questions: {},
        status: 'draft',
      },
    });

    void this.threads
      .startSystemTurn(thread, EXAM_GENERATE_KICKOFF_INPUT, {
        caption: 'Building your exam from the weakest spots in your memory…',
      })
      .then(
        () => this.reconcileGeneration(examId, thread.userId),
        (err: unknown) => {
          this.logger.warn({ err, examId, threadId: thread.id }, 'exam generation turn failed');
          return this.reconcileGeneration(examId, thread.userId);
        },
      )
      .catch((err: unknown) => {
        this.logger.warn({ err, examId }, 'exam generation reconciliation failed');
      });

    return { examId, status: 'draft' };
  }

  /** Server-computed bottom-5 weighted concepts — the dashboard's own numbers. */
  private async targetingFor(userId: string, trackSlug: string): Promise<ExamTarget[]> {
    const data = await this.dashboard.get(userId, { now: new Date() });
    const track = data.readiness.find((entry) => entry.track === trackSlug);
    if (track === undefined) throw new UnknownTrackError(trackSlug);
    return track.weakest.map(({ concept, name, effective }) => ({ concept, name, effective }));
  }

  /**
   * A generation turn that settles while the exam is still `draft` produced
   * no ui_create_exam call — surface it instead of leaving a silent spinner.
   */
  private async reconcileGeneration(examId: string, userId: string): Promise<void> {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId } });
    if (exam === null || exam.status !== 'draft') return;
    this.logger.warn(
      { examId, tag: 'prompt-bug' },
      'generation turn settled without ui_create_exam — exam still draft',
    );
    this.sink.emitToUser(userId, {
      type: 'turn.error',
      threadId: exam.threadId,
      message: 'Exam generation did not finish. Start a new exam to try again.',
      retryable: true,
    });
  }

  /**
   * Pins the exam-workdir ignore pattern into `.git/info/exclude` — same
   * semantics as .gitignore but server-owned and uncommitted, so workspaces
   * created before Phase 4 (or seeded fixtures without a .gitignore) get the
   * integrity guarantee without a mid-session commit racing a live turn.
   */
  private async ensureExamIgnoreRule(userId: string): Promise<void> {
    await this.workspaces.ensureWorkspace(userId);
    const excludePath = path.join(this.workspaces.pathFor(userId), '.git', 'info', 'exclude');
    let current = '';
    try {
      current = await fs.readFile(excludePath, 'utf8');
    } catch {
      current = '';
    }
    if (current.split('\n').includes(EXAM_IGNORE_PATTERN)) return;
    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    const addition =
      '# EduAgent exam integrity: exam workdirs stay untracked until grading force-adds them.\n' +
      `${EXAM_IGNORE_PATTERN}\n`;
    await fs.writeFile(
      excludePath,
      current === '' || current.endsWith('\n') ? current + addition : `${current}\n${addition}`,
      'utf8',
    );
  }

  // ------------------------------------------------------------------- reads

  /** The exam iff it exists AND belongs to this user (routes 404 on null). */
  async get(userId: string, examId: string): Promise<Exam | null> {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId } });
    return exam !== null && exam.userId === userId ? exam : null;
  }

  async list(userId: string): Promise<Exam[]> {
    return this.prisma.exam.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  }

  // ------------------------------------------------------------------- start

  /**
   * Stamps `startedAt` (ready → in_progress). Idempotent while in_progress —
   * a reconnecting client re-fetching its deadline must not error.
   */
  async start(
    userId: string,
    examId: string,
    now: Date = new Date(),
  ): Promise<{ startedAt: Date; deadline: Date } | null> {
    const exam = await this.get(userId, examId);
    if (exam === null) return null;
    const config = parseExamConfig(exam.config);
    if (exam.status === 'in_progress' && exam.startedAt !== null) {
      return { startedAt: exam.startedAt, deadline: examDeadline(exam.startedAt, config.durationMin) };
    }
    if (exam.status !== 'ready') {
      throw new ExamStateError(`This exam cannot start from status "${exam.status}".`, exam.status);
    }
    await this.prisma.exam.update({
      where: { id: exam.id },
      data: { status: 'in_progress', startedAt: now },
    });
    return { startedAt: now, deadline: examDeadline(now, config.durationMin) };
  }

  // ---------------------------------------------------------------- autosave

  /** Upserts answers while in_progress and inside deadline+grace. */
  async autosave(
    userId: string,
    examId: string,
    answers: ExamAnswers,
    now: Date = new Date(),
  ): Promise<Exam | null> {
    const exam = await this.get(userId, examId);
    if (exam === null) return null;
    if (exam.status !== 'in_progress' || exam.startedAt === null) {
      throw new ExamStateError(
        `Answers can only be saved while the exam is in progress (status: "${exam.status}").`,
        exam.status,
      );
    }
    const config = parseExamConfig(exam.config);
    if (examExpired(exam.startedAt, config.durationMin, now)) {
      throw new DeadlinePassedError();
    }
    return this.prisma.exam.update({
      where: { id: exam.id },
      data: { answers: answers as Prisma.InputJsonValue },
    });
  }

  // ------------------------------------------------------------------ submit

  /**
   * Submits the exam and starts the grading turn. Past deadline+grace the
   * request body is IGNORED in favor of the last autosaved answers — the
   * deadline is server-authoritative, but the sitting still gets graded.
   * A `submitted` exam with no result re-kicks grading (recovery from a
   * grading turn that died without ui_grade_exam).
   */
  async submit(
    userId: string,
    examId: string,
    answers: ExamAnswers,
    now: Date = new Date(),
  ): Promise<{ autoSubmitted: boolean } | null> {
    const exam = await this.get(userId, examId);
    if (exam === null) return null;
    if (exam.status === 'submitted' && exam.result === null) {
      if (this.threads.turnInFlight(exam.threadId)) {
        throw new ExamStateError('This exam is being graded — the result is on its way.', exam.status);
      }
      const stored = (exam.answers ?? {}) as ExamAnswers;
      await this.startGrading(exam, stored, false);
      return { autoSubmitted: false };
    }
    if (exam.status !== 'in_progress' || exam.startedAt === null) {
      throw new ExamStateError(
        `This exam cannot be submitted from status "${exam.status}".`,
        exam.status,
      );
    }
    const config = parseExamConfig(exam.config);
    const expired = examExpired(exam.startedAt, config.durationMin, now);
    const finalAnswers = expired ? ((exam.answers ?? {}) as ExamAnswers) : answers;
    await this.finalize(exam, finalAnswers, expired);
    return { autoSubmitted: expired };
  }

  /**
   * The one path from in_progress to submitted+grading, shared by submit()
   * and the sweep: snapshot pre-exam readiness, persist answers, write coding
   * submissions into the exam workdirs, rotate the thread onto exam-grade
   * instructions, start the grading turn.
   */
  private async finalize(exam: Exam, answers: ExamAnswers, autoSubmitted: boolean): Promise<void> {
    const config = parseExamConfig(exam.config);

    // Exact "before" for the result snapshot — same math as the dashboard,
    // computed fresh (explicit `now` bypasses the cache).
    let readinessBefore: number | undefined;
    try {
      const data = await this.dashboard.get(exam.userId, { now: new Date() });
      readinessBefore = data.readiness.find((entry) => entry.track === exam.trackSlug)?.score;
    } catch (err) {
      this.logger.warn({ err, examId: exam.id }, 'pre-exam readiness snapshot failed');
    }
    const newConfig: ExamConfig = {
      ...config,
      ...(readinessBefore !== undefined ? { readinessBefore } : {}),
    };

    // Atomic in_progress → submitted: submit() and the sweep can race at the
    // deadline boundary — whichever loses this conditional update must NOT
    // start a second grading turn (double file updates, double spend).
    const transition = await this.prisma.exam.updateMany({
      where: { id: exam.id, status: 'in_progress' },
      data: {
        status: 'submitted',
        submittedAt: new Date(),
        answers: answers as Prisma.InputJsonValue,
        config: newConfig as Prisma.InputJsonValue,
      },
    });
    if (transition.count === 0) {
      this.logger.info({ examId: exam.id }, 'exam already submitted by a concurrent path — skipping');
      return;
    }
    await this.startGrading({ ...exam, config: newConfig as Prisma.JsonValue }, answers, autoSubmitted);
  }

  private async startGrading(
    exam: Exam,
    answers: ExamAnswers,
    autoSubmitted: boolean,
  ): Promise<void> {
    const questions = examQuestionsSchema.parse(exam.questions);
    const submissionPaths = await this.writeCodingSubmissions(exam, questions, answers);

    const thread = await this.prisma.thread.findUnique({ where: { id: exam.threadId } });
    if (thread === null) {
      throw new Error(`exam ${exam.id} references missing thread ${exam.threadId}`);
    }
    // Rotate generate → grade developerInstructions: the status is already
    // `submitted`, so the forced re-resume rebuilds onto the grading template.
    this.threads.invalidateInstructions(thread);

    const turnText = buildExamGradingTurn({
      examId: exam.id,
      trackSlug: exam.trackSlug,
      questions,
      answers,
      submissionPaths,
      autoSubmitted,
    });
    void this.threads
      .startSystemTurn(thread, turnText, {
        caption: autoSubmitted
          ? 'Time expired — the tutor is grading the autosaved answers.'
          : 'Exam submitted — the tutor is grading it now.',
      })
      .then(
        () => this.reconcileGrading(exam.id, exam.userId),
        (err: unknown) => {
          this.logger.warn({ err, examId: exam.id }, 'exam grading turn failed');
          return this.reconcileGrading(exam.id, exam.userId);
        },
      )
      .catch((err: unknown) => {
        this.logger.warn({ err, examId: exam.id }, 'exam grading reconciliation failed');
      });
  }

  /** Coding answers land on disk so the agent can run the hidden tests (plans/01 §5.2). */
  private async writeCodingSubmissions(
    exam: Exam,
    questions: ExamQuestions,
    answers: ExamAnswers,
  ): Promise<Record<string, string>> {
    const workspace = this.workspaces.pathFor(exam.userId);
    const paths: Record<string, string> = {};
    for (const section of questions.sections) {
      for (const question of section.questions) {
        if (question.type !== 'coding') continue;
        const answer = answers[question.id];
        if (answer === undefined || answer.trim() === '') continue;
        const relPath = submissionRelPath(
          `exam-${exam.id}-${question.id}`,
          question.language ?? 'txt',
        );
        const absPath = path.join(workspace, relPath);
        await fs.mkdir(path.dirname(absPath), { recursive: true });
        await fs.writeFile(absPath, answer, 'utf8');
        paths[question.id] = relPath;
      }
    }
    return paths;
  }

  /**
   * A grading turn that settles with the exam still `submitted` delivered no
   * ui_grade_exam — tell the learner instead of spinning forever. POST
   * /submit on the submitted exam retries grading.
   */
  private async reconcileGrading(examId: string, userId: string): Promise<void> {
    const exam = await this.prisma.exam.findUnique({ where: { id: examId } });
    if (exam === null || exam.status !== 'submitted') return;
    this.logger.warn(
      { examId, tag: 'prompt-bug' },
      'grading turn settled without ui_grade_exam — exam still submitted',
    );
    this.sink.emitToUser(userId, {
      type: 'turn.error',
      threadId: exam.threadId,
      message: 'Grading did not finish. Submit again to retry.',
      retryable: true,
    });
  }

  // ------------------------------------------------------------------- sweep

  /**
   * Auto-submits every in_progress exam past deadline+grace with its last
   * autosaved answers (plans/03 §3.5). Called on a boot-owned interval;
   * exposed for tests and for opportunistic ticks.
   */
  async sweepExpired(now: Date = new Date()): Promise<number> {
    const inProgress = await this.prisma.exam.findMany({
      where: { status: 'in_progress', startedAt: { not: null } },
    });
    let swept = 0;
    for (const exam of inProgress) {
      let config: ExamConfig;
      try {
        config = parseExamConfig(exam.config);
      } catch (err) {
        this.logger.warn({ err, examId: exam.id }, 'sweep: unparseable exam config — skipping');
        continue;
      }
      if (exam.startedAt === null || !examExpired(exam.startedAt, config.durationMin, now)) {
        continue;
      }
      this.logger.info({ examId: exam.id, userId: exam.userId }, 'sweep: auto-submitting expired exam');
      try {
        await this.finalize(exam, (exam.answers ?? {}) as ExamAnswers, true);
        swept += 1;
      } catch (err) {
        this.logger.warn({ err, examId: exam.id }, 'sweep: auto-submit failed');
      }
    }
    return swept;
  }

  /** Starts the deadline sweep (boot); ticks never overlap. */
  startSweep(intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer !== null) return;
    this.sweepTimer = setInterval(() => {
      if (this.sweepInFlight !== null) return;
      this.sweepInFlight = this.sweepExpired()
        .then(() => undefined)
        .catch((err: unknown) => {
          this.logger.warn({ err }, 'exam sweep tick failed');
        })
        .finally(() => {
          this.sweepInFlight = null;
        });
    }, intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweep(): void {
    if (this.sweepTimer === null) return;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }
}
