import type { PrismaClient } from '@prisma/client';
import { dashboardDataSchema, type DashboardData } from '@eduagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { DashboardService } from '../src/learning/index.js';
import { WorkspaceManager } from '../src/workspace/index.js';
import { createPrisma } from '../src/db.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';
import { FIXTURE_NOW, seedFixtureWorkspace, type FixtureRefs } from './helpers/fixture-workspace.js';

/**
 * DashboardService against the hand-authored fixture (plans/06 Phase 3
 * acceptance: every dashboard number cross-checked against hand-computed
 * values). Every expected number below is derived FROM THE PLAN'S FORMULAS
 * and the fixture literals, never from the implementation:
 *
 *   effective = mastery * 2^(-days_since / half_life)
 *   half_life = clamp(7 * 2^review_count, 7, 180)
 *
 * With FIXTURE_NOW = 12:00Z and `last_assessed` bare dates (midnight UTC),
 * days_since = daysAgo + 0.5.
 */

// Fixture concept states → effective mastery at FIXTURE_NOW:
const EFF = {
  // 0.80, rc 3 (hl 56), assessed 14d ago → 0.80 * 2^(-14.5/56)
  selectBasics: 0.8 * 2 ** (-14.5 / 56),
  // 0.55, rc 2 (hl 28), assessed 10d ago → 0.55 * 2^(-10.5/28)
  whereClause: 0.55 * 2 ** (-10.5 / 28),
  // 0.72, rc 1 (hl 14), assessed 2d ago → 0.72 * 2^(-2.5/14)
  innerJoin: 0.72 * 2 ** (-2.5 / 14),
  // 0.40, rc 0 (hl 7), assessed 1d ago → 0.40 * 2^(-1.5/7)
  leftJoin: 0.4 * 2 ** (-1.5 / 7),
};

// Track weights: select-basics 1.0 · inner-join 1.5 · left-join 1.2 ·
// where-clause 1.0 · window-functions 1.3 (untracked → effective 0). Σw = 6.0
const SCORE =
  (100 *
    (1.0 * EFF.selectBasics + 1.5 * EFF.innerJoin + 1.2 * EFF.leftJoin + 1.0 * EFF.whereClause)) /
  6.0;

// Baseline (delta7d): the newest commit ≤ now-7d is the misconception commit
// (8d ago); its mastery.yaml holds only select-basics + where-clause. Decay
// evaluated at now-7d: select-basics assessed 14d ago → 7.5 elapsed days;
// where-clause 10d ago → 3.5.
const BASELINE =
  (100 * (1.0 * (0.8 * 2 ** (-7.5 / 56)) + 1.0 * (0.55 * 2 ** (-3.5 / 28)))) / 6.0;

let prisma: PrismaClient;
let config: AppConfig;
let cleanup: () => Promise<void>;
let service: DashboardService;
let userId: string;
let refs: FixtureRefs;
let data: DashboardData;

beforeAll(async () => {
  prisma = createPrisma(createTestDbUrl('dashboard-service'));
  const dataDir = createTestDataDir();
  config = dataDir.config;
  cleanup = dataDir.cleanup;

  const user = await prisma.user.create({
    data: {
      handle: 'fixture-casey',
      displayName: 'Casey',
      timezone: 'UTC',
      workspacePath: 'set-below',
    },
  });
  userId = user.id;
  const workspaces = new WorkspaceManager(config);
  refs = await seedFixtureWorkspace(workspaces.pathFor(userId), FIXTURE_NOW);

  // Activity strip source: 2 events "today", 1 "yesterday", 1 outside 90d.
  const MS_PER_DAY = 86_400_000;
  for (const hoursAgo of [2, 5]) {
    await prisma.activityEvent.create({
      data: { userId, kind: 'commit', meta: {}, at: new Date(FIXTURE_NOW.getTime() - hoursAgo * 3_600_000) },
    });
  }
  await prisma.activityEvent.create({
    data: { userId, kind: 'exercise_pass', meta: {}, at: new Date(FIXTURE_NOW.getTime() - 30 * 3_600_000) },
  });
  await prisma.activityEvent.create({
    data: { userId, kind: 'commit', meta: {}, at: new Date(FIXTURE_NOW.getTime() - 120 * MS_PER_DAY) },
  });

  service = new DashboardService({ prisma, workspaces });
  data = await service.get(userId, { now: FIXTURE_NOW });
});

afterAll(async () => {
  await prisma.$disconnect();
  await cleanup();
});

describe('DashboardData against the fixture (hand-computed)', () => {
  it('validates against the shared schema', () => {
    expect(() => dashboardDataSchema.parse(data)).not.toThrow();
  });

  it('user: display name + streak 3 (learn/review commits today/-1d/-2d, gap at -3d)', () => {
    expect(data.user).toEqual({ displayName: 'Casey', streakDays: 3 });
  });

  it('continue CTA comes from the session log next_time pointer', () => {
    expect(data.continueCta).toEqual({
      label: 'LEFT JOIN edge cases with NULLs',
      topicSlug: 'sql',
    });
  });

  it('topics: exact effective mastery + fading flags per concept', () => {
    expect(data.topics).toHaveLength(1);
    const topic = data.topics[0]!;
    expect(topic.topic).toBe('sql');
    expect(topic.displayName).toBe('SQL');
    const byId = new Map(topic.concepts.map((c) => [c.id, c]));
    expect(byId.size).toBe(4);

    const sb = byId.get('select-basics')!;
    expect(sb.mastery).toBe(0.8);
    expect(sb.effective).toBeCloseTo(EFF.selectBasics, 10);
    expect(sb.fading).toBe(true); // 0.6686 < 0.8 - 0.1
    expect(sb.reviewCount).toBe(3);
    expect(sb.lastAssessed).toBe(refs.iso(14));

    const wc = byId.get('where-clause')!;
    expect(wc.effective).toBeCloseTo(EFF.whereClause, 10);
    expect(wc.fading).toBe(true); // 0.4241 < 0.55 - 0.1

    const ij = byId.get('inner-join')!;
    expect(ij.effective).toBeCloseTo(EFF.innerJoin, 10);
    expect(ij.fading).toBe(false); // 0.6362 ≥ 0.72 - 0.1

    const lj = byId.get('left-join')!;
    expect(lj.effective).toBeCloseTo(EFF.leftJoin, 10);
    expect(lj.fading).toBe(false); // 0.3448 ≥ 0.40 - 0.1
  });

  it('readiness: weighted score, 7-day delta from the historical ref, weakest-5', () => {
    expect(data.readiness).toHaveLength(1);
    const track = data.readiness[0]!;
    expect(track.track).toBe('sql-interview');
    expect(track.displayName).toBe('SQL Interview Prep');
    expect(track.targetDate).toBe(refs.iso(-45));
    expect(track.score).toBeCloseTo(SCORE, 10);
    expect(track.delta7d).toBeCloseTo(SCORE - BASELINE, 10);

    // Bottom 5 by weight × effective: never-assessed window-functions (0)
    // first, then 1.2·0.3448 < 1.0·0.4241 < 1.0·0.6686 < 1.5·0.6362.
    expect(track.weakest.map((w) => w.concept)).toEqual([
      'window-functions',
      'left-join',
      'where-clause',
      'select-basics',
      'inner-join',
    ]);
    expect(track.weakest[0]!.effective).toBe(0);
    expect(track.weakest[0]!.name).toBe('window-functions'); // untracked → slug as name
    expect(track.weakest[1]!.name).toBe('LEFT JOIN');
  });

  it('review queue: 2 due today, 1 overdue, next concepts ordered by due date', () => {
    expect(data.reviewQueue.dueToday).toBe(2);
    expect(data.reviewQueue.overdue).toBe(1);
    expect(data.reviewQueue.nextConcepts).toEqual(['select-basics', 'inner-join', 'where-clause']);
  });

  it('timeline: all 7 commits, newest first, parsed per the grammar', () => {
    expect(data.timeline).toHaveLength(7);
    expect(data.timeline.map((t) => t.type)).toEqual([
      'review',
      'learn',
      'learn',
      'misconception',
      'learn',
      'learn',
      'profile',
    ]);
    expect(data.timeline[0]!.topic).toBe('sql');
    expect(data.timeline[0]!.deltas).toEqual([]);
    expect(data.timeline[6]!.topic).toBe('general'); // `profile:` has no topic segment
    // The select-basics commit: exact headline delta parse.
    expect(data.timeline[5]!.deltas).toEqual([{ concept: 'select-basics', from: 0.55, to: 0.8 }]);
    expect(data.timeline[5]!.sha).toBe(refs.shas[1]);
    expect(data.timeline[1]!.bullets.length).toBeGreaterThan(0);
  });

  it('decay series: all four concepts, recently-assessed ones ranked first', () => {
    expect(data.decaySeries).toHaveLength(4);
    // interest = (mastery − effective) + 0.15 recent-boost:
    // inner-join 0.0838+0.15 > left-join 0.0552+0.15 > select-basics 0.1314 > where-clause 0.1259
    expect(data.decaySeries.map((s) => s.concept)).toEqual([
      'inner-join',
      'left-join',
      'select-basics',
      'where-clause',
    ]);
  });

  it('decay series points: past decay + 14-day projection (hand-computed)', () => {
    const sb = data.decaySeries.find((s) => s.concept === 'select-basics')!;
    expect(sb.name).toBe('SELECT basics');
    const byDate = new Map(sb.points.map((p) => [p.date, p.effective]));
    // Anchor day (assessed 14d ago): raw mastery, no decay yet.
    expect(byDate.get(refs.iso(14))).toBeCloseTo(0.8, 10);
    // Today (midnight): 14 whole days on the curve → 0.8 · 2^(-14/56).
    expect(byDate.get(refs.iso(0))).toBeCloseTo(0.8 * 2 ** (-14 / 56), 10);
    // Projection end (+14d): 28 days → 0.8 · 2^(-28/56) = 0.8/√2.
    expect(byDate.get(refs.iso(-14))).toBeCloseTo(0.8 / Math.SQRT2, 10);
    // Series spans anchor day → today+14, one point per day.
    expect(sb.points[0]!.date).toBe(refs.iso(14));
    expect(sb.points.at(-1)!.date).toBe(refs.iso(-14));
    expect(sb.points).toHaveLength(29);
  });

  it('activity: a 90-day strip in order, with per-day counts', () => {
    expect(data.activity).toHaveLength(90);
    expect(data.activity[0]!.date).toBe(refs.iso(89));
    expect(data.activity.at(-1)).toEqual({ date: refs.iso(0), count: 2 });
    expect(data.activity.at(-2)).toEqual({ date: refs.iso(1), count: 1 });
    // The 120-days-ago event is outside the strip.
    const total = data.activity.reduce((sum, day) => sum + day.count, 0);
    expect(total).toBe(3);
  });
});

describe('cache behavior', () => {
  it('caches per user until invalidated; explicit now bypasses', async () => {
    const first = await service.get(userId);
    const second = await service.get(userId);
    expect(second).toBe(first); // same object: served from cache
    service.invalidate(userId);
    const third = await service.get(userId);
    expect(third).not.toBe(first); // rebuilt
    const bypass = await service.get(userId, { now: FIXTURE_NOW });
    expect(bypass).not.toBe(third);
  });

  it('keys track-scoped variants separately and invalidates every variant', async () => {
    const global = await service.get(userId);
    const scoped = await service.get(userId, { track: 'sql-interview' });
    expect(await service.get(userId, { track: 'sql-interview' })).toBe(scoped);
    service.invalidate(userId);
    expect(await service.get(userId)).not.toBe(global);
    expect(await service.get(userId, { track: 'sql-interview' })).not.toBe(scoped);
  });
});

describe('track filter', () => {
  it('scopes readiness/topics/decay/timeline while preserving global reviews', async () => {
    const scoped = await service.get(userId, { now: FIXTURE_NOW, track: 'sql-interview' });
    expect(scoped.readiness.map((entry) => entry.track)).toEqual(['sql-interview']);
    expect(scoped.topics.map((entry) => entry.topic)).toEqual(['sql']);
    expect(scoped.decaySeries.length).toBeGreaterThan(0);
    expect(scoped.timeline.every((entry) => entry.topic === 'sql')).toBe(true);
    expect(scoped.reviewQueue).toEqual(data.reviewQueue);
  });

  it('keeps the no-param payload byte-for-byte identical to the pre-filter build', async () => {
    expect(await service.get(userId, { now: FIXTURE_NOW })).toEqual(data);
  });
});

describe('workspace-less user', () => {
  it('returns an empty-but-valid dashboard without creating anything', async () => {
    const bare = await prisma.user.create({
      data: { handle: 'no-ws', displayName: 'Newbie', workspacePath: 'x' },
    });
    const empty = await service.get(bare.id, { now: FIXTURE_NOW });
    expect(() => dashboardDataSchema.parse(empty)).not.toThrow();
    expect(empty.user).toEqual({ displayName: 'Newbie', streakDays: 0 });
    expect(empty.continueCta).toBeUndefined();
    expect(empty.readiness).toEqual([]);
    expect(empty.topics).toEqual([]);
    expect(empty.timeline).toEqual([]);
    expect(empty.reviewQueue).toEqual({ dueToday: 0, overdue: 0, nextConcepts: [] });
    expect(empty.activity).toHaveLength(90);
  });
});
