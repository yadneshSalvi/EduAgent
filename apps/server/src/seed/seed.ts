import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import { trackIntakeSchema } from '@eduagent/shared';
import { workspacePathFor, type AppConfig } from '../config.js';
import { DashboardService } from '../learning/DashboardService.js';
import { WorkspaceManager, type WorkspaceLogger } from '../workspace/index.js';
import { ALEX_TIMEZONE, seedAlexWorkspace, type AlexSeedResult } from './alex.js';
import { SESSIONS, SQL_JOB_DESCRIPTION } from './content.js';
import { buildAlexExamRow } from './exam-row.js';

/**
 * Demo seeding orchestration (plans/02 §7):
 *
 * - `seedDemo()` — wipe + recreate BOTH demo users (alex with ~21 days of
 *   history, sam with an initialized-but-empty workspace) AND purge every
 *   OTHER user (QA/dev leftovers) with their rows + workspaces, so the login
 *   picker shows exactly alex, sam after a full reseed. Idempotent.
 * - `seedDemo({ only: 'alex', force: true })` — reset alex only, recreating
 *   the workspace and derived rows (threads/exercises/exams/activity) while
 *   PRESERVING the User row (`id`, `authId`) so a hosted-demo Clerk link
 *   survives the nightly reset (plans/08 §6).
 *
 * Alex's historical sittings are archived Thread + ItemMirror rows. Their
 * codex ids are deterministic placeholders and archived guards ensure they
 * are replay-only; live resume/fork paths never touch them. Exercise rows stay
 * absent. The past exam also has one terminal graded Exam row with
 * `threadId: null` (exam-row.ts), so /app/exam History needs no fabricated
 * rollout either.
 *
 * Run with the API server STOPPED (or restart it afterwards): the server
 * caches dashboards in memory and holds the SQLite file; seeding underneath a
 * live server leaves stale caches until its next invalidation.
 */

export interface UserSeedReport {
  handle: string;
  userId: string;
  workspacePath: string;
  commits: number;
  /** Present for alex: the mock-exam readiness snapshot two days back. */
  exam?: AlexSeedResult['exam'];
  /** Present for alex: dashboard sanity numbers computed post-seed. */
  dashboard?: {
    sqlReadiness: number;
    sqlDelta7d: number;
    pythonReadiness: number;
    streakDays: number;
    srsDueToday: number;
    fading: string[];
    continueCta: string | null;
  };
  /** Track gallery sanity: progress comes from a schema-valid workspace roadmap. */
  roadmaps?: Array<{ slug: string; head: number; total: number; valid: boolean }>;
}

export interface SeedSummary {
  alex?: UserSeedReport;
  sam?: UserSeedReport;
  elapsedMs: number;
}

export interface SeedOptions {
  config: AppConfig;
  prisma: PrismaClient;
  /** Seed-day instant; defaults to the real clock. */
  now?: Date;
  /** Restrict to one user. */
  only?: 'alex' | 'sam';
  /**
   * With `only`: reset that user even if they exist, preserving the User row.
   * Without `only`, the full reseed always wipes (documented behavior).
   */
  force?: boolean;
  logger?: WorkspaceLogger;
}

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

const DEMO_USERS = {
  alex: { handle: 'alex', displayName: 'Alex', timezone: ALEX_TIMEZONE },
  sam: { handle: 'sam', displayName: 'Sam', timezone: 'UTC' },
} as const;

export async function seedDemo(opts: SeedOptions): Promise<SeedSummary> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const logger = opts.logger ?? noopLogger;
  const targets = opts.only ? [opts.only] : (['alex', 'sam'] as const);
  const summary: SeedSummary = { elapsedMs: 0 };

  // Full reseed = pristine demo world: every user that is NOT a demo user
  // (QA handles, dev logins) goes away entirely, rows and workspace both —
  // otherwise the local-mode login picker keeps listing them forever.
  if (!opts.only) {
    await purgeNonDemoUsers(opts, logger);
  }

  for (const key of targets) {
    const spec = DEMO_USERS[key];
    const existing = await opts.prisma.user.findUnique({ where: { handle: spec.handle } });
    if (existing && opts.only && !opts.force) {
      throw new Error(
        `user "${spec.handle}" already exists — pass --force to reset (preserves the User row)`,
      );
    }
    const user = await resetUser(opts, existing, spec, logger);
    const report = await buildWorkspace(opts, user, key, now, logger);
    summary[key] = report;
    logger.info(
      { handle: spec.handle, userId: user.id, commits: report.commits },
      'demo user seeded',
    );
  }

  summary.elapsedMs = Date.now() - started;
  return summary;
}

/**
 * Deletes derived rows + workspace dir. Full reseed (no `only`) also drops
 * the User row (spec: wipe + recreate, authId reset); `--force` keeps it.
 */
async function resetUser(
  opts: SeedOptions,
  existing: User | null,
  spec: (typeof DEMO_USERS)[keyof typeof DEMO_USERS],
  logger: WorkspaceLogger,
): Promise<User> {
  const { prisma, config } = opts;
  const preserveRow = Boolean(opts.only && opts.force);

  if (existing) {
    await deleteDerivedRows(prisma, existing.id);
    await removeWorkspaceDir(config, existing.workspacePath, logger);
    if (!preserveRow) {
      await prisma.user.delete({ where: { id: existing.id } });
    }
  }
  // Seeded ids are the handles themselves: stable workspace paths across
  // reseeds (data/workspaces/alex), which the demo runbook relies on.
  const id = preserveRow && existing ? existing.id : spec.handle;
  await removeWorkspaceDir(config, workspacePathFor(config, id), logger);

  const data = {
    handle: spec.handle,
    displayName: spec.displayName,
    timezone: spec.timezone,
    avatarSeed: spec.handle,
    workspacePath: workspacePathFor(config, id),
  };
  if (preserveRow && existing) {
    return prisma.user.update({ where: { id: existing.id }, data });
  }
  return prisma.user.create({ data: { id, ...data } });
}

/** Every row hanging off a user, in FK-safe order (the User row survives). */
async function deleteDerivedRows(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.exerciseAttempt.deleteMany({ where: { exercise: { userId } } });
  await prisma.exercise.deleteMany({ where: { userId } });
  await prisma.itemMirror.deleteMany({ where: { thread: { userId } } });
  await prisma.exam.deleteMany({ where: { userId } });
  await prisma.thread.deleteMany({ where: { userId } });
  await prisma.track.deleteMany({ where: { userId } });
  await prisma.activityEvent.deleteMany({ where: { userId } });
}

/** Full-reseed cleanup: drop every user that is not alex/sam, workspace included. */
async function purgeNonDemoUsers(opts: SeedOptions, logger: WorkspaceLogger): Promise<void> {
  const demoHandles = Object.values(DEMO_USERS).map((u) => u.handle);
  const strays = await opts.prisma.user.findMany({
    where: { handle: { notIn: demoHandles } },
  });
  for (const stray of strays) {
    await deleteDerivedRows(opts.prisma, stray.id);
    await removeWorkspaceDir(opts.config, stray.workspacePath, logger);
    await opts.prisma.user.delete({ where: { id: stray.id } });
    logger.info({ handle: stray.handle, userId: stray.id }, 'purged non-demo user');
  }
}

/** rm -rf, but only ever inside <dataDir>/workspaces (defense in depth). */
async function removeWorkspaceDir(
  config: AppConfig,
  dir: string,
  logger: WorkspaceLogger,
): Promise<void> {
  const resolved = path.resolve(config.dataDir, dir);
  const workspacesRoot = path.join(config.dataDir, 'workspaces') + path.sep;
  if (!resolved.startsWith(workspacesRoot)) {
    logger.warn({ dir: resolved }, 'refusing to delete a path outside workspaces/');
    return;
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

async function buildWorkspace(
  opts: SeedOptions,
  user: User,
  key: 'alex' | 'sam',
  now: Date,
  logger: WorkspaceLogger,
): Promise<UserSeedReport> {
  const workspaces = new WorkspaceManager(opts.config, { logger });
  const base: UserSeedReport = {
    handle: user.handle,
    userId: user.id,
    workspacePath: workspaces.pathFor(user.id),
    commits: 0,
  };

  if (key === 'sam') {
    // Sam is onboarding-fresh by design: template only, no profile commit.
    await workspaces.ensureWorkspace(user.id);
    base.commits = 1;
    return base;
  }

  const result = await seedAlexWorkspace(workspaces.pathFor(user.id), now);
  base.commits = result.commits.length;
  base.exam = result.exam;

  const threadIdByCommit = await createAlexSessionRows(opts.prisma, user.id, result);

  // One ActivityEvent per commit, shaped like the MemoryPipeline's rows, so
  // the 90-day activity strip and any feed read seeded history identically.
  const git = workspaces.git(user.id);
  const rows: Prisma.ActivityEventCreateManyInput[] = [];
  for (const commit of result.commits) {
    const { stats } = await git.diffForCommit(commit.sha);
    const threadId = threadIdByCommit.get(commit.sha);
    rows.push({
      userId: user.id,
      kind: 'commit',
      at: commit.instant,
      meta: {
        sha: commit.sha,
        type: commit.type,
        topic: commit.topic,
        headline: commit.headline,
        bullets: commit.bullets,
        deltas: commit.deltas,
        stats,
        ...(threadId ? { threadId } : {}),
      } satisfies Prisma.InputJsonValue,
    });
  }
  await opts.prisma.activityEvent.createMany({ data: rows });

  // The graded Exam DB row for the mock two days back — same content as the
  // workspace record, no thread (see the module doc above).
  const examCommit = result.commits.find((c) => c.type === 'exam');
  if (examCommit) {
    await opts.prisma.exam.create({
      data: buildAlexExamRow({
        userId: user.id,
        before: result.exam.before,
        after: result.exam.after,
        gradedAt: examCommit.instant,
        targeting: result.exam.targeting,
      }),
    });
  }

  await createAlexTrackRows(opts.prisma, user.id, result);

  // Post-seed sanity snapshot (the CLI prints it; the test asserts the bands).
  const model = await workspaces.readLearnerModel(user.id);
  base.roadmaps = ['sql-interview', 'python-dsa'].map((slug) => {
    const roadmap = model.roadmaps.find((candidate) => candidate.track === slug);
    return {
      slug,
      head: roadmap?.days.find((day) => day.status === 'upcoming')?.day ?? 0,
      total: roadmap?.days.length ?? 0,
      valid: roadmap !== undefined && !model.needsRepair.includes(`tracks/${slug}/roadmap.yaml`),
    };
  });
  const dashboard = await new DashboardService({ prisma: opts.prisma, workspaces }).get(user.id, {
    now,
  });
  const sql = dashboard.readiness.find((r) => r.track === 'sql-interview');
  const python = dashboard.readiness.find((r) => r.track === 'python-dsa');
  base.dashboard = {
    sqlReadiness: round1(sql?.score ?? 0),
    sqlDelta7d: round1(sql?.delta7d ?? 0),
    pythonReadiness: round1(python?.score ?? 0),
    streakDays: dashboard.user.streakDays,
    srsDueToday: dashboard.reviewQueue.dueToday,
    fading: dashboard.topics.flatMap((t) =>
      t.concepts.filter((c) => c.fading).map((c) => `${t.topic}/${c.id}`),
    ),
    continueCta: dashboard.continueCta?.label ?? null,
  };
  return base;
}

/** Replay-only chat history for every authored sitting in the screenplay. */
async function createAlexSessionRows(
  prisma: PrismaClient,
  userId: string,
  result: AlexSeedResult,
): Promise<Map<string, string>> {
  const bySlug = new Map(result.sessions.map((seeded) => [seeded.session.slug, seeded]));
  const threads: Prisma.ThreadCreateManyInput[] = [];
  const items: Prisma.ItemMirrorCreateManyInput[] = [];
  const threadIdByCommit = new Map<string, string>();

  for (let index = 0; index < SESSIONS.length; index++) {
    const session = SESSIONS[index]!;
    const seeded = bySlug.get(session.slug);
    if (!seeded) throw new Error(`seedDemo: no generated transcript for ${session.slug}`);
    const number = index + 1;
    const threadId = `seed-alex-s${String(number).padStart(2, '0')}`;
    const intent =
      session.slug === 'review-sprint'
        ? 'revise'
        : session.slug === 'sql-join-filtering'
          ? 'mistakes'
          : 'teach';
    threads.push({
      id: threadId,
      userId,
      codexThreadId: threadId,
      mode: session.mode === 'review' ? 'review' : 'learn',
      topicSlug: session.topics[0]!,
      trackSlug: session.track,
      roadmapDay: session.roadmapDay,
      intent,
      title: session.title,
      status: 'archived',
      sessionToken: `seed-${number}`,
      createdAt: seeded.startedAt,
      lastActiveAt: seeded.endedAt,
    });
    threadIdByCommit.set(seeded.commitSha, threadId);

    const totalIntervals = session.transcript.length + 1;
    const durationMs = seeded.endedAt.getTime() - seeded.startedAt.getTime();
    const at = (position: number): Date =>
      new Date(seeded.startedAt.getTime() + Math.floor((durationMs * position) / totalIntervals));
    items.push({
      id: `${threadId}-i000`,
      threadId,
      role: 'system',
      kind: 'message',
      payload: { text: '[session-start]' },
      createdAt: at(0),
    });
    for (let turnIndex = 0; turnIndex < session.transcript.length; turnIndex++) {
      const turn = session.transcript[turnIndex]!;
      items.push({
        id: `${threadId}-i${String(turnIndex + 1).padStart(3, '0')}`,
        threadId,
        role: turn.role,
        kind: 'message',
        payload: { text: turn.md },
        createdAt: at(turnIndex + 1),
      });
    }
    items.push({
      id: `${threadId}-i${String(session.transcript.length + 1).padStart(3, '0')}`,
      threadId,
      role: 'agent',
      kind: 'wrap',
      payload: {
        day: session.roadmapDay,
        summary_md: seeded.summaryMd,
        concept_deltas: seeded.conceptDeltas,
      },
      createdAt: seeded.endedAt,
    });
  }

  await prisma.thread.createMany({ data: threads });
  await prisma.itemMirror.createMany({ data: items });
  return threadIdByCommit;
}

async function createAlexTrackRows(
  prisma: PrismaClient,
  userId: string,
  result: AlexSeedResult,
): Promise<void> {
  const sqlIntake = trackIntakeSchema.parse({
    subject: 'SQL Interview Prep',
    goalType: 'interview',
    sourceText: SQL_JOB_DESCRIPTION,
    sourceKind: 'job-description',
    currentLevel: 'intermediate',
    style: 'mix',
    priorKnowledge: 'Strong JavaScript and frontend experience; rusty day-to-day SQL.',
    targetDate: '2026-09-02',
    studyDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
    minutesPerDay: 45,
  });
  const pythonIntake = trackIntakeSchema.parse({
    subject: 'Python DS&A',
    goalType: 'interview',
    subtopics:
      'Python fluency plus common arrays, maps, pointers, trees, graphs, heaps, and DP patterns.',
    currentLevel: 'beginner',
    style: 'drill-first',
    priorKnowledge: 'Comfortable solving problems in JavaScript; new to interview-style Python.',
    totalDays: 12,
    studyDays: ['mon', 'wed', 'fri'],
    minutesPerDay: 30,
  });
  const sqlCreatedAt =
    result.commits.find(
      (commit) => commit.type === 'profile' && commit.headline.startsWith('onboarding'),
    )?.instant ?? result.commits[0]!.instant;
  const pythonCreatedAt =
    result.commits.find(
      (commit) => commit.type === 'profile' && commit.headline === 'add python-dsa track',
    )?.instant ?? sqlCreatedAt;
  const latestFor = (topic: string): Date =>
    [...result.commits].reverse().find((commit) => commit.topic === topic)?.instant ?? sqlCreatedAt;

  await prisma.track.create({
    data: {
      id: 'alex-track-sql-interview',
      userId,
      slug: 'sql-interview',
      title: 'SQL Interview Prep',
      goalType: 'interview',
      status: 'active',
      intake: sqlIntake as Prisma.InputJsonValue,
      accent: accentFor('sql-interview'),
      createdAt: sqlCreatedAt,
      lastActiveAt: latestFor('sql'),
    },
  });
  await prisma.track.create({
    data: {
      id: 'alex-track-python-dsa',
      userId,
      slug: 'python-dsa',
      title: 'Python DS&A',
      goalType: 'interview',
      status: 'active',
      intake: pythonIntake as Prisma.InputJsonValue,
      accent: accentFor('python-dsa'),
      createdAt: pythonCreatedAt,
      lastActiveAt: latestFor('python'),
    },
  });
}

/** Byte-for-byte the deterministic gallery accent algorithm in TrackService. */
function accentFor(slug: string): string {
  const accents = ['violet', 'cyan', 'amber', 'rose', 'emerald', 'blue'] as const;
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length]!;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
