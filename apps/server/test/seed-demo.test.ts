import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { dump as yamlDump } from 'js-yaml';
import {
  addDays,
  dashboardDataSchema,
  examAnswersSchema,
  examQuestionsSchema,
  examResultSchema,
  localDate,
  masteryFileSchema,
  profileFrontmatterSchema,
  roadmapFileSchema,
  sessionLogFrontmatterSchema,
  srsQueueFileSchema,
  trackFileSchema,
  trackBriefFrontmatterSchema,
  trackIntakeSchema,
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
    expect(model.roadmaps.map((r) => r.track)).toEqual(['python-dsa', 'sql-interview']);
  });

  it('profile, track artifacts, mastery, srs and ALL session logs parse under shared schemas', async () => {
    const read = (rel: string) => fs.readFile(path.join(alexDir, rel), 'utf8');
    parseFrontmatterFile(profileFrontmatterSchema, await read('profile.md'));
    parseYamlFile(trackFileSchema, await read('tracks/sql-interview/track.yaml'));
    parseYamlFile(trackFileSchema, await read('tracks/python-dsa/track.yaml'));
    parseFrontmatterFile(
      trackBriefFrontmatterSchema,
      await read('tracks/sql-interview/brief.md'),
    );
    parseFrontmatterFile(trackBriefFrontmatterSchema, await read('tracks/python-dsa/brief.md'));
    parseYamlFile(masteryFileSchema, await read('topics/sql/mastery.yaml'));
    parseYamlFile(masteryFileSchema, await read('topics/python/mastery.yaml'));
    parseYamlFile(srsQueueFileSchema, await read('srs/queue.yaml'));
    const sessionFiles = (await fs.readdir(path.join(alexDir, 'sessions'))).filter((f) =>
      f.endsWith('.md'),
    );
    expect(sessionFiles).toHaveLength(18);
    for (const file of sessionFiles) {
      const { frontmatter } = parseFrontmatterFile(
        sessionLogFrontmatterSchema,
        await read(`sessions/${file}`),
      );
      expect(frontmatter.track).toMatch(/^(sql-interview|python-dsa)$/);
      expect(frontmatter.roadmap_day).toBeGreaterThan(0);
      expect(frontmatter.title).toBeTruthy();
    }
  });

  it('roadmaps use live-completion serialization and land at day 13/22 and day 3/12', async () => {
    const sqlRaw = await fs.readFile(
      path.join(alexDir, 'tracks/sql-interview/roadmap.yaml'),
      'utf8',
    );
    const pythonRaw = await fs.readFile(
      path.join(alexDir, 'tracks/python-dsa/roadmap.yaml'),
      'utf8',
    );
    const sql = parseYamlFile(roadmapFileSchema, sqlRaw);
    const python = parseYamlFile(roadmapFileSchema, pythonRaw);

    expect(sqlRaw).toBe(yamlDump(sql, { noRefs: true, lineWidth: -1 }));
    expect(pythonRaw).toBe(yamlDump(python, { noRefs: true, lineWidth: -1 }));
    expect(sql.schedule).toEqual({
      study_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      minutes_per_day: 45,
      start_date: addDays(today, -21),
    });
    expect(sql.days.filter((day) => day.status === 'complete')).toHaveLength(12);
    expect(sql.days.filter((day) => day.status === 'upcoming')).toHaveLength(10);
    expect(sql.days.find((day) => day.status === 'upcoming')?.day).toBe(13);
    expect(python.schedule.study_days).toEqual(['mon', 'wed', 'fri']);
    expect(python.schedule.minutes_per_day).toBe(30);
    expect(python.days.filter((day) => day.status === 'complete')).toHaveLength(2);
    expect(python.days.filter((day) => day.status === 'upcoming')).toHaveLength(10);
    expect(python.days.find((day) => day.status === 'upcoming')?.day).toBe(3);
    expect(summary.alex!.roadmaps).toEqual([
      { slug: 'sql-interview', head: 13, total: 22, valid: true },
      { slug: 'python-dsa', head: 3, total: 12, valid: true },
    ]);
  });

  it('session screenplay is chronological, clubbed, and drives every completion date', async () => {
    const sessionFiles = (await fs.readdir(path.join(alexDir, 'sessions'))).filter((file) =>
      file.endsWith('.md'),
    );
    const logs = await Promise.all(
      sessionFiles.map(async (file) => ({
        file,
        ...parseFrontmatterFile(
          sessionLogFrontmatterSchema,
          await fs.readFile(path.join(alexDir, 'sessions', file), 'utf8'),
        ).frontmatter,
      })),
    );
    const sql = parseYamlFile(
      roadmapFileSchema,
      await fs.readFile(path.join(alexDir, 'tracks/sql-interview/roadmap.yaml'), 'utf8'),
    );
    const python = parseYamlFile(
      roadmapFileSchema,
      await fs.readFile(path.join(alexDir, 'tracks/python-dsa/roadmap.yaml'), 'utf8'),
    );
    const sqlLogs = logs
      .filter((log) => log.track === 'sql-interview')
      .sort((a, b) => a.date.localeCompare(b.date));
    expect(sqlLogs.map((log) => log.roadmap_day)).toEqual(
      [...sqlLogs.map((log) => log.roadmap_day)].sort((a, b) => a! - b!),
    );
    expect(sqlLogs.at(-1)).toMatchObject({
      file: `${addDays(today, -1)}-sql-left-join.md`,
      roadmap_day: 13,
    });
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: `${addDays(today, -10)}-python-kickoff.md`,
          track: 'python-dsa',
          roadmap_day: 1,
        }),
        expect.objectContaining({
          file: `${addDays(today, -8)}-python-hashmaps-strings.md`,
          track: 'python-dsa',
          roadmap_day: 2,
        }),
      ]),
    );
    for (const roadmap of [sql, python]) {
      for (const day of roadmap.days.filter((candidate) => candidate.status === 'complete')) {
        const dates = logs
          .filter((log) => log.track === roadmap.track && log.roadmap_day === day.day)
          .map((log) => log.date)
          .sort();
        expect(day.completed_on, `${roadmap.track} day ${day.day}`).toBe(dates.at(-1));
      }
    }
    const flavored = sqlLogs.filter((log) =>
      ['Left joins — revisited', 'Fixing the WHERE-before-JOIN gap'].includes(log.title ?? ''),
    );
    expect(flavored).toHaveLength(2);
    expect(
      flavored.every((log) => sql.days[log.roadmap_day! - 1]?.status === 'complete'),
    ).toBe(true);
  });

  it('track directory layout is native and the SQL source mirrors the intake', async () => {
    const tree = await workspaces.git(summary.alex!.userId).lsTree();
    expect(tree.filter((file) => /^tracks\/[^/]+\.yaml$/.test(file))).toEqual([]);
    expect(tree).toEqual(
      expect.arrayContaining([
        'tracks/sql-interview/track.yaml',
        'tracks/sql-interview/roadmap.yaml',
        'tracks/sql-interview/brief.md',
        'tracks/sql-interview/sources/job-description.md',
        'tracks/python-dsa/track.yaml',
        'tracks/python-dsa/roadmap.yaml',
        'tracks/python-dsa/brief.md',
      ]),
    );
    const source = await fs.readFile(
      path.join(alexDir, 'tracks/sql-interview/sources/job-description.md'),
      'utf8',
    );
    expect(source).toContain('Backend Engineer — Data Services');
    expect(source).toContain('60-minute SQL exercise');
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
  it('145–170 commits, every one parseable under the §3 grammar', async () => {
    const log = await workspaces.git(summary.alex!.userId).log();
    expect(log.length).toBeGreaterThanOrEqual(145);
    expect(log.length).toBeLessThanOrEqual(170);
    expect(log.length).toBe(summary.alex!.commits);
    for (const info of log) {
      expect(parseCommit(info.message), `off-grammar commit: ${info.message}`).not.toBeNull();
    }
  });

  it('commit types include the interleaved source, roadmap, and completion plan history', async () => {
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
    expect(byType.get('plan')).toBe(17);

    const chronological = [...log].reverse().map((info) => info.message.split('\n')[0]!);
    expect(chronological.indexOf('plan(sql-interview): capture source material')).toBeLessThan(
      chronological.indexOf('plan(sql-interview): create roadmap — 22 days'),
    );
    expect(chronological).toContain('plan(python-dsa): create roadmap — 12 days');
    expect(
      chronological.filter((message) => /^plan\(sql-interview\): day \d+ complete —/.test(message)),
    ).toHaveLength(12);
    expect(
      chronological.filter((message) => /^plan\(python-dsa\): day \d+ complete —/.test(message)),
    ).toHaveLength(2);
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

describe('seeded Track DB rows', () => {
  it('creates two active rows with valid intake and TrackService-compatible accents', async () => {
    const tracks = await prisma.track.findMany({
      where: { userId: summary.alex!.userId },
      orderBy: { slug: 'asc' },
    });
    expect(tracks.map((track) => [track.slug, track.status])).toEqual([
      ['python-dsa', 'active'],
      ['sql-interview', 'active'],
    ]);
    for (const track of tracks) {
      expect(() => trackIntakeSchema.parse(track.intake)).not.toThrow();
      expect(track.accent).toBe(expectedAccent(track.slug));
    }
    const sql = tracks.find((track) => track.slug === 'sql-interview')!;
    const intake = trackIntakeSchema.parse(sql.intake);
    expect(intake.targetDate).toBe('2026-09-02');
    expect(intake.sourceKind).toBe('job-description');
    expect(intake.sourceText).toBe(
      await fs.readFile(
        path.join(alexDir, 'tracks/sql-interview/sources/job-description.md'),
        'utf8',
      ),
    );
  });
});

describe('seeded Exam DB row (Phase 6: History shows the mock sitting)', () => {
  it('one graded, thread-less exam whose JSON parses under the shared schemas', async () => {
    const exams = await prisma.exam.findMany({ where: { userId: summary.alex!.userId } });
    expect(exams).toHaveLength(1);
    const exam = exams[0]!;
    expect(exam.status).toBe('graded');
    expect(exam.threadId).toBeNull();
    expect(exam.trackSlug).toBe('sql-interview');

    const questions = examQuestionsSchema.parse(exam.questions);
    expect(questions.sections.flatMap((s) => s.questions)).toHaveLength(8);
    const result = examResultSchema.parse(exam.result);
    expect(result.total).toBe(71);
    expect(result.per_question.reduce((sum, q) => sum + q.points_awarded, 0)).toBe(71);
    expect(questions.sections.flatMap((s) => s.questions).reduce((s, q) => s + q.points, 0)).toBe(
      100,
    );
    // The row's readiness snapshot IS the workspace record's snapshot.
    expect(result.readiness_before).toBeCloseTo(summary.alex!.exam!.before, 5);
    expect(result.readiness_after).toBeCloseTo(summary.alex!.exam!.after, 5);
    // Every question has an answer as sat, so the results view renders full.
    const answers = examAnswersSchema.parse(exam.answers);
    for (const q of questions.sections.flatMap((s) => s.questions)) {
      expect(answers[q.id], `answer for ${q.id}`).toBeTruthy();
    }
  });

  it('is dated with the exam commit two days back (createdAt < startedAt < submittedAt < gradedAt)', async () => {
    const exam = (await prisma.exam.findFirst({ where: { userId: summary.alex!.userId } }))!;
    expect(localDate(exam.gradedAt!, ALEX_TIMEZONE)).toBe(addDays(today, -2));
    expect(exam.createdAt.getTime()).toBeLessThan(exam.startedAt!.getTime());
    expect(exam.startedAt!.getTime()).toBeLessThan(exam.submittedAt!.getTime());
    expect(exam.submittedAt!.getTime()).toBeLessThan(exam.gradedAt!.getTime());
    // Grading lands with the exam commit — same instant the timeline shows.
    const events = await prisma.activityEvent.findMany({
      where: { userId: summary.alex!.userId, kind: 'commit' },
    });
    const examEvent = events.find(
      (e) => (e.meta as { type?: string }).type === 'exam',
    );
    expect(examEvent).toBeDefined();
    expect(exam.gradedAt!.getTime()).toBe(examEvent!.at.getTime());
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
    expect(await prisma.track.count({ where: { userId: after!.id } })).toBe(2);
  }, 60_000);

  it('--user alex without --force refuses to touch an existing user', async () => {
    await expect(seedDemo({ config, prisma, now: SEED_NOW, only: 'alex' })).rejects.toThrow(
      /--force/,
    );
  });

  it('--user alex --force leaves other (non-demo) users alone', async () => {
    await prisma.user.create({
      data: {
        id: 'qa-keeper',
        handle: 'qa-keeper',
        displayName: 'QA Keeper',
        workspacePath: 'workspaces/qa-keeper',
      },
    });
    await seedDemo({ config, prisma, now: SEED_NOW, only: 'alex', force: true });
    expect(await prisma.user.findUnique({ where: { handle: 'qa-keeper' } })).not.toBeNull();
  }, 60_000);

  it('full reseed is idempotent AND purges non-demo users (pristine login picker)', async () => {
    // Simulates QA leftovers: a user with derived rows and a workspace dir
    // (qa-keeper from the previous test is still around too — both must go).
    const junkDir = path.join(config.dataDir, 'workspaces', 'qa-junk');
    await fs.mkdir(junkDir, { recursive: true });
    const junk = await prisma.user.create({
      data: {
        id: 'qa-junk',
        handle: 'qa-junk',
        displayName: 'QA Junk',
        workspacePath: 'workspaces/qa-junk',
      },
    });
    await prisma.activityEvent.create({
      data: { userId: junk.id, kind: 'session_start', meta: {} },
    });

    const again = await seedDemo({ config, prisma, now: SEED_NOW });
    expect(again.alex!.commits).toBe(summary.alex!.commits);
    const alex = await prisma.user.findUnique({ where: { handle: 'alex' } });
    expect(alex!.authId).toBeNull(); // full wipe resets the Clerk link by design
    const handles = (await prisma.user.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (u) => u.handle,
    );
    expect(handles).toEqual(['alex', 'sam']); // purged + alex first for the picker
    expect(await prisma.activityEvent.count({ where: { userId: junk.id } })).toBe(0);
    await expect(fs.access(junkDir)).rejects.toThrow(); // workspace dir removed too
  }, 120_000);

  it('full seed completes in under 60s', () => {
    expect(summary.elapsedMs).toBeLessThan(60_000);
  });
});

function expectedAccent(slug: string): string {
  const accents = ['violet', 'cyan', 'amber', 'rose', 'emerald', 'blue'] as const;
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return accents[hash % accents.length]!;
}
