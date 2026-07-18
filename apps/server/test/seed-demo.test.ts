import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  addDays,
  dashboardDataSchema,
  localDate,
  masteryFileSchema,
  profileFrontmatterSchema,
  sessionLogFrontmatterSchema,
  srsQueueFileSchema,
  trackFileSchema,
  type DashboardData,
} from '@eduagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { DashboardService } from '../src/learning/index.js';
import { ALEX_TIMEZONE } from '../src/seed/alex.js';
import { seedDemo, type SeedSummary } from '../src/seed/seed.js';
import { parseCommit } from '../src/workspace/GitService.js';
import { parseFrontmatterFile, parseYamlFile } from '../src/workspace/learner-files.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

/**
 * The Phase 5 seeder validation suite (plans/02 §7, plans/07 §1): seeds the
 * demo world into a throwaway DATA_DIR + db and asserts every number the
 * demo video leans on. Bands (not exact values) so clock-offset variation
 * within the seed day can never flake them; the content.ts calibration
 * comment points here.
 */

/** Deterministic seed-day instant: noon in Alex's timezone. */
const SEED_NOW = new Date('2026-07-18T19:00:00Z');

let prisma: PrismaClient;
let config: AppConfig;
let cleanup: () => Promise<void>;
let workspaces: WorkspaceManager;
let summary: SeedSummary;
let dashboard: DashboardData;
let alexDir: string;
let today: string;

beforeAll(async () => {
  prisma = createPrisma(createTestDbUrl('seed-demo'));
  const dataDir = createTestDataDir();
  config = dataDir.config;
  cleanup = dataDir.cleanup;
  workspaces = new WorkspaceManager(config);

  summary = await seedDemo({ config, prisma, now: SEED_NOW });
  alexDir = summary.alex!.workspacePath;
  today = localDate(SEED_NOW, ALEX_TIMEZONE);
  dashboard = await new DashboardService({ prisma, workspaces }).get(summary.alex!.userId, {
    now: SEED_NOW,
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  await cleanup();
});

describe('seeded workspace files', () => {
  it('every learner-model file is zod-valid (no repairs pending)', async () => {
    const model = await workspaces.readLearnerModel(summary.alex!.userId);
    expect(model.needsRepair).toEqual([]);
    expect(model.profile).not.toBeNull();
    expect(model.profile!.frontmatter.timezone).toBe(ALEX_TIMEZONE);
    expect(model.tracks.map((t) => t.track)).toEqual(['python-dsa', 'sql-interview']);
  });

  it('profile, tracks, mastery, srs and ALL session logs parse under the shared schemas', async () => {
    const read = (rel: string) => fs.readFile(path.join(alexDir, rel), 'utf8');
    parseFrontmatterFile(profileFrontmatterSchema, await read('profile.md'));
    parseYamlFile(trackFileSchema, await read('tracks/sql-interview.yaml'));
    parseYamlFile(trackFileSchema, await read('tracks/python-dsa.yaml'));
    parseYamlFile(masteryFileSchema, await read('topics/sql/mastery.yaml'));
    parseYamlFile(masteryFileSchema, await read('topics/python/mastery.yaml'));
    parseYamlFile(srsQueueFileSchema, await read('srs/queue.yaml'));
    const sessionFiles = (await fs.readdir(path.join(alexDir, 'sessions'))).filter((f) =>
      f.endsWith('.md'),
    );
    expect(sessionFiles.length).toBeGreaterThanOrEqual(15);
    for (const file of sessionFiles) {
      parseFrontmatterFile(sessionLogFrontmatterSchema, await read(`sessions/${file}`));
    }
  });

  it('~35 concepts across sql + python with varied mastery and review counts', async () => {
    const read = (rel: string) => fs.readFile(path.join(alexDir, rel), 'utf8');
    const sql = parseYamlFile(masteryFileSchema, await read('topics/sql/mastery.yaml'));
    const python = parseYamlFile(masteryFileSchema, await read('topics/python/mastery.yaml'));
    const total = sql.concepts.length + python.concepts.length;
    expect(total).toBeGreaterThanOrEqual(30);
    expect(total).toBeLessThanOrEqual(40);
    const reviewCounts = new Set([...sql.concepts, ...python.concepts].map((c) => c.review_count));
    expect(reviewCounts.size).toBeGreaterThanOrEqual(4);
  });

  it('misconceptions: 3 open + 4 resolved, including the WHERE-before-JOIN one', async () => {
    const files = await Promise.all(
      ['sql', 'python'].map((t) =>
        fs.readFile(path.join(alexDir, `topics/${t}/misconceptions.md`), 'utf8'),
      ),
    );
    const all = files.join('\n');
    expect(all.match(/^## \[OPEN\]/gm) ?? []).toHaveLength(3);
    expect(all.match(/^## \[RESOLVED \d{4}-\d{2}-\d{2}\]/gm) ?? []).toHaveLength(4);
    expect(all).toContain('## [OPEN] Believes WHERE filters before JOIN completes');
  });

  it('exam record two days back carries a readiness snapshot with a ~+9 jump', async () => {
    const examDate = addDays(today, -2);
    const raw = await fs.readFile(
      path.join(alexDir, `exams/${examDate}-sql-interview-mock.md`),
      'utf8',
    );
    expect(raw).toContain(`date: ${examDate}`);
    expect(raw).toContain('track: sql-interview');
    expect(raw).toContain('score: 71');
    const delta = Number(/^- Delta: \+(\d+\.\d)$/m.exec(raw)?.[1]);
    expect(delta).toBeGreaterThanOrEqual(8);
    expect(delta).toBeLessThanOrEqual(10);
    // The record's numbers are the generator's own snapshot — cross-check.
    expect(delta).toBeCloseTo(summary.alex!.exam!.delta, 5);
    expect(raw).toContain(`- Before: ${summary.alex!.exam!.before.toFixed(1)} / 100`);
    expect(raw).toContain(`- After: ${summary.alex!.exam!.after.toFixed(1)} / 100`);
  });
});

describe('seeded git history', () => {
  it('130–150 commits, every one parseable under the §3 grammar', async () => {
    const log = await workspaces.git(summary.alex!.userId).log();
    expect(log.length).toBeGreaterThanOrEqual(130);
    expect(log.length).toBeLessThanOrEqual(150);
    expect(log.length).toBe(summary.alex!.commits);
    for (const info of log) {
      expect(parseCommit(info.message), `off-grammar commit: ${info.message}`).not.toBeNull();
    }
  });

  it('commit types vary across learn/review/exam/misconception/profile', async () => {
    const log = await workspaces.git(summary.alex!.userId).log();
    const byType = new Map<string, number>();
    for (const info of log) {
      const type = parseCommit(info.message)!.type;
      byType.set(type, (byType.get(type) ?? 0) + 1);
    }
    expect(byType.get('learn') ?? 0).toBeGreaterThanOrEqual(40);
    expect(byType.get('review') ?? 0).toBeGreaterThanOrEqual(30);
    expect(byType.get('exam')).toBe(1);
    expect(byType.get('misconception')).toBe(7);
    expect(byType.get('profile')).toBe(2);
  });

  it('one ActivityEvent per commit, mirroring the MemoryPipeline shape', async () => {
    const events = await prisma.activityEvent.findMany({
      where: { userId: summary.alex!.userId },
    });
    expect(events).toHaveLength(summary.alex!.commits);
    expect(events.every((e) => e.kind === 'commit')).toBe(true);
    const meta = events[0]!.meta as { sha?: string; headline?: string; stats?: object };
    expect(meta.sha).toBeTruthy();
    expect(meta.headline).toBeTruthy();
    expect(meta.stats).toBeTruthy();
  });
});

describe('dashboard numbers (the demo video contract)', () => {
  it('payload validates against the shared DashboardData schema', () => {
    expect(() => dashboardDataSchema.parse(dashboard)).not.toThrow();
  });

  it('sql-interview readiness ~64 and climbing; python-dsa ~40', () => {
    const sql = dashboard.readiness.find((r) => r.track === 'sql-interview')!;
    const python = dashboard.readiness.find((r) => r.track === 'python-dsa')!;
    expect(sql.score).toBeGreaterThanOrEqual(58);
    expect(sql.score).toBeLessThanOrEqual(68);
    expect(sql.delta7d).toBeGreaterThan(0);
    expect(python.score).toBeGreaterThanOrEqual(35);
    expect(python.score).toBeLessThanOrEqual(45);
  });

  it('streak reads ≥ 12 days', () => {
    expect(dashboard.user.streakDays).toBeGreaterThanOrEqual(12);
    expect(dashboard.user.displayName).toBe('Alex');
  });

  it('exactly 3 SRS reviews due today, none overdue', () => {
    expect(dashboard.reviewQueue.dueToday).toBe(3);
    expect(dashboard.reviewQueue.overdue).toBe(0);
    expect(dashboard.reviewQueue.nextConcepts).toContain('window-functions');
    expect(dashboard.reviewQueue.nextConcepts).toContain('indexes-basics');
  });

  it('window-functions and indexes-basics are fading — and nothing else', () => {
    const fading = dashboard.topics.flatMap((t) =>
      t.concepts.filter((c) => c.fading).map((c) => `${t.topic}/${c.id}`),
    );
    expect(fading.sort()).toEqual(['sql/indexes-basics', 'sql/window-functions']);
  });

  it('newest timeline includes the exam commit dated two days back', () => {
    const exam = dashboard.timeline.find((e) => e.type === 'exam');
    expect(exam).toBeDefined();
    expect(dashboard.timeline.indexOf(exam!)).toBeLessThan(20);
    expect(localDate(new Date(exam!.date), ALEX_TIMEZONE)).toBe(addDays(today, -2));
    expect(exam!.deltas.length).toBeGreaterThanOrEqual(5);
  });

  it('continue CTA is the LEFT JOIN pointer from the latest session log', () => {
    expect(dashboard.continueCta).toEqual({
      label: 'LEFT JOIN edge cases with NULLs',
      topicSlug: 'sql',
    });
  });

  it('activity strip shows commits on each of the last 12 days', () => {
    const last12 = dashboard.activity.slice(-12);
    expect(last12).toHaveLength(12);
    for (const day of last12) {
      expect(day.count, `no activity on ${day.date}`).toBeGreaterThan(0);
    }
  });

  it('weakest-concepts list is anchored by the unlearned + fading concepts', () => {
    const weakest = dashboard.readiness
      .find((r) => r.track === 'sql-interview')!
      .weakest.map((w) => w.concept);
    expect(weakest).toContain('query-optimization');
    expect(weakest).toContain('indexes-basics');
  });

  it('decay series charts the fading concepts', () => {
    const charted = dashboard.decaySeries.map((s) => s.concept);
    expect(charted).toContain('window-functions');
    expect(charted).toContain('indexes-basics');
  });
});

describe('sam, idempotency and --force', () => {
  it('sam has an initialized-but-empty workspace (onboarding-fresh)', async () => {
    const samId = summary.sam!.userId;
    const sam = await prisma.user.findUnique({ where: { id: samId } });
    expect(sam!.displayName).toBe('Sam');
    expect(workspaces.hasWorkspace(samId)).toBe(true);
    expect(await workspaces.hasCommittedProfile(samId)).toBe(false);
    const log = await workspaces.git(samId).log();
    expect(log).toHaveLength(1);
    expect(log[0]!.message).toBe('system: initialize memory');
  });

  it('--user alex --force resets history but preserves User.id and authId', async () => {
    const before = await prisma.user.findUnique({ where: { handle: 'alex' } });
    await prisma.user.update({
      where: { id: before!.id },
      data: { authId: 'clerk_demo_link' },
    });
    const headBefore = await workspaces.git(before!.id).headSha();

    const forced = await seedDemo({ config, prisma, now: SEED_NOW, only: 'alex', force: true });

    const after = await prisma.user.findUnique({ where: { handle: 'alex' } });
    expect(after!.id).toBe(before!.id);
    expect(after!.authId).toBe('clerk_demo_link');
    expect(forced.alex!.commits).toBe(summary.alex!.commits);
    // Fully deterministic given the same --now: identical HEAD sha.
    expect(await workspaces.git(after!.id).headSha()).toBe(headBefore);
    const events = await prisma.activityEvent.count({ where: { userId: after!.id } });
    expect(events).toBe(summary.alex!.commits);
  }, 60_000);

  it('--user alex without --force refuses to touch an existing user', async () => {
    await expect(seedDemo({ config, prisma, now: SEED_NOW, only: 'alex' })).rejects.toThrow(
      /--force/,
    );
  });

  it('full reseed is idempotent (wipe + recreate, same world)', async () => {
    const again = await seedDemo({ config, prisma, now: SEED_NOW });
    expect(again.alex!.commits).toBe(summary.alex!.commits);
    const alex = await prisma.user.findUnique({ where: { handle: 'alex' } });
    expect(alex!.authId).toBeNull(); // full wipe resets the Clerk link by design
    const users = await prisma.user.count();
    expect(users).toBe(2);
  }, 120_000);

  it('full seed completes in under 60s', () => {
    expect(summary.elapsedMs).toBeLessThan(60_000);
  });
});
