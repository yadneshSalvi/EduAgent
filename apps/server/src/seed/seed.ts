import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient, User } from '@prisma/client';
import { workspacePathFor, type AppConfig } from '../config.js';
import { DashboardService } from '../learning/DashboardService.js';
import { WorkspaceManager, type WorkspaceLogger } from '../workspace/index.js';
import { ALEX_TIMEZONE, seedAlexWorkspace, type AlexSeedResult } from './alex.js';

/**
 * Demo seeding orchestration (plans/02 §7):
 *
 * - `seedDemo()` — wipe + recreate BOTH demo users (alex with ~21 days of
 *   history, sam with an initialized-but-empty workspace). Idempotent.
 * - `seedDemo({ only: 'alex', force: true })` — reset alex only, recreating
 *   the workspace and derived rows (threads/exercises/exams/activity) while
 *   PRESERVING the User row (`id`, `authId`) so a hosted-demo Clerk link
 *   survives the nightly reset (plans/08 §6).
 *
 * Deliberately seeds NO Thread/Exam/Exercise rows: a Thread row must carry a
 * real codex thread id (with a rollout) or downstream fork/resume calls fail,
 * and codex rollouts cannot be fabricated offline — see docs in the Phase 5
 * report. Alex's past exam lives in the workspace (exam record + exam commit),
 * which is all the dashboard reads.
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
    await prisma.exerciseAttempt.deleteMany({ where: { exercise: { userId: existing.id } } });
    await prisma.exercise.deleteMany({ where: { userId: existing.id } });
    await prisma.itemMirror.deleteMany({ where: { thread: { userId: existing.id } } });
    await prisma.exam.deleteMany({ where: { userId: existing.id } });
    await prisma.thread.deleteMany({ where: { userId: existing.id } });
    await prisma.activityEvent.deleteMany({ where: { userId: existing.id } });
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

  // One ActivityEvent per commit, shaped like the MemoryPipeline's rows, so
  // the 90-day activity strip and any feed read seeded history identically.
  const git = workspaces.git(user.id);
  const rows: Prisma.ActivityEventCreateManyInput[] = [];
  for (const commit of result.commits) {
    const { stats } = await git.diffForCommit(commit.sha);
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
      } satisfies Prisma.InputJsonValue,
    });
  }
  await opts.prisma.activityEvent.createMany({ data: rows });

  // Post-seed sanity snapshot (the CLI prints it; the test asserts the bands).
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

const round1 = (n: number): number => Math.round(n * 10) / 10;
