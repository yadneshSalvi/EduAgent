import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient, Thread } from '@prisma/client';
import type { TrackIntake, WsEvent } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppServerClient } from '../src/codex/index.js';
import { createPrisma } from '../src/db.js';
import { TrackService, TrackStateError } from '../src/learning/index.js';
import { ThreadManager, type TrackThreadService } from '../src/threads/index.js';
import { MemoryPipeline, WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

const USER = 'user-tracks-1';
const NOW = new Date('2026-07-23T12:00:00Z'); // Thursday

const INTAKE: TrackIntake = {
  subject: 'SQL Interview',
  goalType: 'interview',
  sourceKind: 'job-description',
  sourceText: 'SQL joins, CTEs, and query optimization',
  currentLevel: 'intermediate',
  style: 'drill-first',
  totalDays: 5,
  studyDays: ['mon', 'wed', 'fri'],
  minutesPerDay: 45,
};

function recordingSink() {
  const records: Array<{ target: 'thread' | 'user'; id: string; event: WsEvent }> = [];
  return {
    records,
    emitToThread(id: string, event: WsEvent) {
      records.push({ target: 'thread', id, event });
    },
    emitToUser(id: string, event: WsEvent) {
      records.push({ target: 'user', id, event });
    },
  };
}

class FakeTrackThreads implements TrackThreadService {
  constructor(private readonly prisma: PrismaClient) {}
  readonly kickoffs: string[] = [];
  readonly kickoffInputs: string[] = [];
  runExclusive<T>(_userId: string, job: () => Promise<T>): Promise<T> {
    return job();
  }
  createPlanThread(
    userId: string,
    opts: { trackSlug: string; intake: TrackIntake },
  ): Promise<Thread> {
    return this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: `plan-${opts.trackSlug}-${Date.now()}-${Math.random()}`,
        mode: 'plan',
        trackSlug: opts.trackSlug,
        title: `Planning — ${opts.intake.subject}`,
        sessionToken: `plan-token-${Date.now()}-${Math.random()}`,
      },
    });
  }
  createTrackSession(
    userId: string,
    opts: { trackSlug: string; day: number; intent: 'teach' | 'revise' | 'mistakes' },
  ): Promise<Thread> {
    return this.prisma.thread.create({
      data: {
        userId,
        codexThreadId: `learn-${Date.now()}-${Math.random()}`,
        mode: 'learn',
        topicSlug: 'sql',
        trackSlug: opts.trackSlug,
        roadmapDay: opts.day,
        intent: opts.intent,
        title: `Day ${opts.day}`,
        sessionToken: `learn-token-${Date.now()}-${Math.random()}`,
      },
    });
  }
  startSystemTurn(thread: Thread, text: string): Promise<void> {
    this.kickoffs.push(thread.id);
    this.kickoffInputs.push(text);
    return new Promise(() => {}); // reconciliation is driven explicitly by these unit tests
  }
  ensureThread(): never {
    throw new Error('not used');
  }
  startTurn(): Promise<void> {
    return Promise.resolve();
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  turnInFlight(): boolean {
    return false;
  }
  inFlightThreads(): string[] {
    return [];
  }
  resumeAll(): Promise<void> {
    return Promise.resolve();
  }
}

describe('TrackService', () => {
  let prisma: PrismaClient;
  let workspaces: WorkspaceManager;
  let cleanup: () => Promise<void>;
  let sink: ReturnType<typeof recordingSink>;
  let memory: MemoryPipeline;
  let threads: FakeTrackThreads;
  let service: TrackService;

  beforeEach(async () => {
    const data = createTestDataDir();
    cleanup = data.cleanup;
    workspaces = new WorkspaceManager(data.config);
    prisma = createPrisma(createTestDbUrl('tracks-service'));
    await prisma.user.create({
      data: {
        id: USER,
        handle: `tracks-${Date.now()}-${Math.random()}`,
        displayName: 'Alex',
        timezone: 'UTC',
        workspacePath: workspaces.pathFor(USER),
      },
    });
    sink = recordingSink();
    memory = new MemoryPipeline({ workspaces, prisma, emitter: sink });
    threads = new FakeTrackThreads(prisma);
    service = new TrackService({
      prisma,
      workspaces,
      threads,
      memory,
      sink,
      now: () => new Date(NOW),
    });
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await cleanup();
  });

  async function write(rel: string, content: string): Promise<void> {
    const absolute = path.join(workspaces.pathFor(USER), rel);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content, 'utf8');
  }

  async function installPlan(slug: string, firstComplete = false): Promise<void> {
    await workspaces.ensureWorkspace(USER);
    await write(
      `tracks/${slug}/track.yaml`,
      `track: ${slug}\ndisplay_name: SQL Interview\nitems:\n  - concept: joins\n    topic: sql\n    weight: 1.5\n`,
    );
    const days = Array.from({ length: 5 }, (_, index) => {
      const day = index + 1;
      return [
        `  - day: ${day}`,
        `    title: Topic ${day}`,
        `    status: ${firstComplete && day === 1 ? 'complete' : 'upcoming'}`,
        ...(firstComplete && day === 1 ? ['    completed_on: 2026-07-21'] : []),
        '    topics:',
        '      - topic: sql',
        '        concepts: [joins]',
        `    subtopics: [Part ${day}A, Part ${day}B]`,
      ].join('\n');
    });
    await write(
      `tracks/${slug}/roadmap.yaml`,
      [
        `track: ${slug}`,
        'created: 2026-07-01',
        'schedule:',
        '  study_days: [mon, wed, fri]',
        '  minutes_per_day: 45',
        '  start_date: 2026-07-01',
        'days:',
        ...days,
      ].join('\n') + '\n',
    );
    await workspaces.git(USER).commitAll(`plan(${slug}): create roadmap — 5 days`);
  }

  async function activeTrack(slug = 'sql-interview', firstComplete = false): Promise<void> {
    await installPlan(slug, firstComplete);
    await prisma.track.create({
      data: {
        userId: USER,
        slug,
        title: 'SQL Interview',
        goalType: 'interview',
        status: 'active',
        intake: INTAKE as Prisma.InputJsonValue,
        accent: 'violet',
      },
    });
  }

  it('creates generating tracks, commits sources, reconciles, retries, sweeps, and suffixes slugs', async () => {
    const created = await service.create(USER, INTAKE);
    expect(created.track).toMatchObject({ slug: 'sql-interview', status: 'generating' });
    expect(created.planThreadId).toBeTruthy();
    expect(threads.kickoffs).toEqual([created.planThreadId]);
    expect(
      await fs.readFile(
        path.join(workspaces.pathFor(USER), 'tracks/sql-interview/sources/job-description.md'),
        'utf8',
      ),
    ).toBe(INTAKE.sourceText);
    expect((await workspaces.git(USER).log({ maxCount: 1 }))[0]?.message).toContain(
      'plan(sql-interview): capture source material',
    );

    const collision = await service.create(USER, {
      ...INTAKE,
      sourceText: undefined,
      sourceKind: undefined,
    });
    expect(collision.track.slug).toBe('sql-interview-2');
    await service.reconcileGeneration(USER, 'sql-interview-2');
    expect(
      (await prisma.track.findFirstOrThrow({ where: { slug: 'sql-interview-2' } })).status,
    ).toBe('failed');

    await installPlan('sql-interview');
    await service.reconcileGeneration(USER, 'sql-interview');
    expect((await prisma.track.findFirstOrThrow({ where: { slug: 'sql-interview' } })).status).toBe(
      'active',
    );

    await prisma.track.update({ where: { id: created.track.id }, data: { status: 'failed' } });
    const retried = await service.generate(USER, 'sql-interview');
    expect(retried.planThreadId).toBe(created.planThreadId);
    await expect(service.generate(USER, 'sql-interview')).rejects.toBeInstanceOf(TrackStateError);

    await prisma.track.updateMany({
      where: { status: 'generating' },
      data: { lastActiveAt: NOW },
    });

    await prisma.track.create({
      data: {
        userId: USER,
        slug: 'stale-track',
        title: 'Stale',
        goalType: 'mastery',
        status: 'generating',
        intake: INTAKE as Prisma.InputJsonValue,
        lastActiveAt: new Date(NOW.getTime() - 16 * 60_000),
      },
    });
    expect(await service.sweepStaleGenerating()).toBe(1);
    expect((await prisma.track.findFirstOrThrow({ where: { slug: 'stale-track' } })).status).toBe(
      'failed',
    );
  });

  it('derives completion-paced dates and completes idempotently through final status', async () => {
    await activeTrack('sql-interview', true);
    const before = await service.detail(USER, 'sql-interview');
    expect(before.headDay).toBe(2);
    expect(before.nextPlannedDate).toBe('2026-07-24'); // Thursday → Friday

    const completed = await service.completeDay(USER, 'sql-interview', 2, {
      threadId: 'thread-day-2',
    });
    expect(completed.completedDays).toEqual([1, 2]);
    expect(completed.headDay).toBe(3);
    expect(completed.roadmap?.days.find((day) => day.day === 3)?.plannedDate).toBe('2026-07-24');
    const afterFirst = await workspaces.git(USER).headSha();
    await service.completeDay(USER, 'sql-interview', 2, { threadId: 'thread-day-2' });
    expect(await workspaces.git(USER).headSha()).toBe(afterFirst);
    await expect(service.completeDay(USER, 'sql-interview', 99)).rejects.toBeInstanceOf(
      TrackStateError,
    );

    for (const day of [3, 4, 5]) await service.completeDay(USER, 'sql-interview', day);
    expect((await service.detail(USER, 'sql-interview')).status).toBe('completed');
    const planCommits = (await workspaces.git(USER).log()).filter((commit) =>
      commit.message.startsWith('plan(sql-interview): day'),
    );
    expect(planCommits).toHaveLength(4);
    expect(planCommits.some((commit) => commit.message.includes('Reflowed'))).toBe(true);
    expect(await prisma.activityEvent.count({ where: { userId: USER, kind: 'commit' } })).toBe(4);
    expect(
      sink.records.filter(
        (record) => record.target === 'user' && record.event.type === 'memory.commit',
      ),
    ).toHaveLength(4);
  });

  it('reflects completion immediately even when another directory shadows the slug (QA F2)', async () => {
    await activeTrack('sql-interview', true);
    // Impostor from a failed generation: an alphabetically EARLIER directory
    // whose files claim `track: sql-interview` — before the dir↔field guard it
    // shadowed the real roadmap in every `.find()`, so completion never showed.
    await write(
      'tracks/a-failed-attempt/track.yaml',
      'track: sql-interview\ndisplay_name: Impostor\nitems:\n  - concept: joins\n    topic: sql\n    weight: 1\n',
    );
    await write(
      'tracks/a-failed-attempt/roadmap.yaml',
      [
        'track: sql-interview',
        'created: 2026-07-01',
        'schedule:',
        '  study_days: [mon, wed, fri]',
        '  minutes_per_day: 45',
        '  start_date: 2026-07-01',
        'days:',
        ...Array.from({ length: 5 }, (_, index) =>
          [
            `  - day: ${index + 1}`,
            `    title: Impostor ${index + 1}`,
            '    status: upcoming',
            '    topics:',
            '      - topic: sql',
            '        concepts: [joins]',
            '    subtopics: [A, B]',
          ].join('\n'),
        ),
      ].join('\n') + '\n',
    );
    await workspaces.git(USER).commitAll('system(general): leftover impostor files');

    const before = await service.detail(USER, 'sql-interview');
    expect(before.completedDays).toEqual([1]); // the REAL roadmap, not the impostor's
    expect(before.headDay).toBe(2);

    const after = await service.completeDay(USER, 'sql-interview', 2);
    expect(after.completedDays).toEqual([1, 2]);
    expect(after.headDay).toBe(3);
    const listed = await service.list(USER);
    expect(listed.find((track) => track.slug === 'sql-interview')?.completedDays).toEqual([1, 2]);

    const model = await workspaces.readLearnerModel(USER);
    expect(model.needsRepair).toContain('tracks/a-failed-attempt/roadmap.yaml');
    expect(model.needsRepair).toContain('tracks/a-failed-attempt/track.yaml');
  });

  it('normalizes a parroted track slug during reconciliation (QA F1)', async () => {
    const slug = 'sql-for-backend-interviews';
    await workspaces.ensureWorkspace(USER);
    await write(
      `tracks/${slug}/track.yaml`,
      'track: sql-interview\ndisplay_name: SQL for backend interviews\nitems:\n  - concept: joins\n    topic: sql\n    weight: 1.5\n',
    );
    await write(
      `tracks/${slug}/roadmap.yaml`,
      [
        'track: sql-interview',
        'created: 2026-07-19',
        'schedule:',
        '  study_days: [mon, wed, fri]',
        '  minutes_per_day: 45',
        '  start_date: 2026-07-19',
        'days:',
        ...Array.from({ length: 5 }, (_, index) =>
          [
            `  - day: ${index + 1}`,
            `    title: Topic ${index + 1}`,
            '    status: upcoming',
            '    topics:',
            '      - topic: sql',
            '        concepts: [joins]',
            '    subtopics: [A, B]',
          ].join('\n'),
        ),
      ].join('\n') + '\n',
    );
    await workspaces.git(USER).commitAll(`plan(${slug}): create roadmap — 5 days`);
    await prisma.track.create({
      data: {
        userId: USER,
        slug,
        title: 'SQL for backend interviews',
        goalType: 'interview',
        status: 'generating',
        intake: INTAKE as Prisma.InputJsonValue,
        accent: 'violet',
      },
    });

    await service.reconcileGeneration(USER, slug);

    expect((await prisma.track.findFirstOrThrow({ where: { slug } })).status).toBe('active');
    const head = (await workspaces.git(USER).log({ maxCount: 1 }))[0];
    expect(head?.message).toContain(`plan(${slug}): normalize track slug`);
    for (const file of ['roadmap.yaml', 'track.yaml']) {
      expect(await workspaces.git(USER).fileAtRef('HEAD', `tracks/${slug}/${file}`)).toContain(
        `track: ${slug}`,
      );
    }
    expect((await service.detail(USER, slug)).roadmap).not.toBeNull();
    expect(
      sink.records.some(
        (record) =>
          record.event.type === 'memory.commit' &&
          record.event.commit.headline.includes('normalize track slug'),
      ),
    ).toBe(true);
  });

  it('canonicalizes agent-written roadmap style at activation so completions diff cleanly (QA G2)', async () => {
    const slug = 'sql-interview';
    await workspaces.ensureWorkspace(USER);
    await write(
      `tracks/${slug}/track.yaml`,
      `track: ${slug}\ndisplay_name: SQL Interview\nitems:\n  - concept: joins\n    topic: sql\n    weight: 1.5\n`,
    );
    // Messy-but-valid agent style: unquoted dates, inline arrays — everything
    // the js-yaml dump renders differently.
    await write(
      `tracks/${slug}/roadmap.yaml`,
      [
        `track: ${slug}`,
        'created: 2026-07-19',
        'schedule: { study_days: [mon, wed, fri], minutes_per_day: 45, start_date: 2026-07-19 }',
        'days:',
        ...Array.from({ length: 5 }, (_, index) =>
          [
            `  - { day: ${index + 1}, title: Topic ${index + 1}, status: upcoming,`,
            '    topics: [{ topic: sql, concepts: [joins] }], subtopics: [A, B] }',
          ].join('\n'),
        ),
      ].join('\n') + '\n',
    );
    await workspaces.git(USER).commitAll(`plan(${slug}): create roadmap — 5 days`);
    await prisma.track.create({
      data: {
        userId: USER,
        slug,
        title: 'SQL Interview',
        goalType: 'interview',
        status: 'generating',
        intake: INTAKE as Prisma.InputJsonValue,
        accent: 'violet',
      },
    });

    await service.reconcileGeneration(USER, slug);

    expect((await prisma.track.findFirstOrThrow({ where: { slug } })).status).toBe('active');
    const git = workspaces.git(USER);
    expect((await git.log({ maxCount: 1 }))[0]?.message).toContain(
      `plan(${slug}): normalize roadmap format`,
    );
    // Canonical = idempotent under the roadmap dump the server uses.
    const raw = (await git.fileAtRef('HEAD', `tracks/${slug}/roadmap.yaml`))!;
    const { load, dump } = await import('js-yaml');
    const { roadmapFileSchema } = await import('@eduagent/shared');
    expect(raw).toBe(dump(roadmapFileSchema.parse(load(raw)), { noRefs: true, lineWidth: -1 }));

    await service.completeDay(USER, slug, 1);
    const completion = (await git.log({ maxCount: 1 }))[0]!;
    expect(completion.message).toContain(`plan(${slug}): day 1 complete`);
    const { stats } = await git.diffForCommit(completion.sha);
    expect(stats).toEqual({ filesChanged: 1, insertions: 2, deletions: 1 });
  });

  it('feeds the reconciliation error into the retry kickoff (QA F1b)', async () => {
    const created = await service.create(USER, INTAKE);
    expect(threads.kickoffInputs.at(-1)).toBe('[plan-roadmap]');

    await service.reconcileGeneration(USER, 'sql-interview'); // no plan files committed
    expect((await prisma.track.findFirstOrThrow({ where: { slug: 'sql-interview' } })).status).toBe(
      'failed',
    );

    const retried = await service.generate(USER, 'sql-interview');
    expect(retried.planThreadId).toBe(created.planThreadId);
    const retryInput = threads.kickoffInputs.at(-1) ?? '';
    expect(retryInput).toContain('[plan-roadmap-retry]');
    expect(retryInput).toContain('missing at HEAD');
    expect(retryInput).toContain('exactly "sql-interview"');
  });

  it('deduplicates thread-backed logs, keeps thread-less logs, and counts commits', async () => {
    await activeTrack('sql-interview');
    const thread = await prisma.thread.create({
      data: {
        userId: USER,
        codexThreadId: 'track-session-1',
        mode: 'learn',
        topicSlug: 'sql',
        trackSlug: 'sql-interview',
        roadmapDay: 2,
        intent: 'revise',
        title: 'Day 2 — revisited',
        sessionToken: 'track-session-token-1',
        createdAt: new Date('2026-07-20T10:00:00Z'),
        lastActiveAt: new Date('2026-07-20T10:25:00Z'),
      },
    });
    await prisma.activityEvent.create({
      data: { userId: USER, kind: 'commit', meta: { threadId: thread.id, sha: 'abc' } },
    });
    await write(
      'sessions/2026-07-20-sql-joins.md',
      `---\ndate: 2026-07-20\nmode: learn\ntrack: sql-interview\nroadmap_day: 2\ntitle: Join practice\ntopics: [sql]\nduration_estimate: 25m\nconcepts_touched: [joins]\n---\nWorked on joins.\n`,
    );
    await write(
      'sessions/2026-07-19-sql-joins-followup.md',
      `---\ndate: 2026-07-19\nmode: learn\ntrack: sql-interview\nroadmap_day: 3\ntitle: Thread-less join follow-up\ntopics: [sql]\nduration_estimate: 20m\nconcepts_touched: [joins]\n---\nWorked on joins without a thread.\n`,
    );
    const merged = await service.sessions(USER, 'sql-interview');
    expect(merged.sessions.map((session) => session.kind).sort()).toEqual(['log', 'thread']);
    expect(merged.sessions.find((session) => session.kind === 'thread')).toMatchObject({
      roadmapDay: 2,
      commitCount: 1,
      thread: { intent: 'revise' },
    });
    expect(merged.sessions.find((session) => session.kind === 'log')).toMatchObject({
      roadmapDay: 3,
      title: 'Thread-less join follow-up',
    });
    const roadmap = (await service.detail(USER, 'sql-interview')).roadmap;
    expect(roadmap?.days[1]?.sessionCount).toBe(1);
    expect(roadmap?.days[2]?.sessionCount).toBe(1);
  });

  it('waits behind the real per-user queue and emits the server commit exactly once', async () => {
    await activeTrack('sql-interview');
    const manager = new ThreadManager({
      prisma,
      client: {} as AppServerClient,
      workspaces,
      memory: { beforeTurn: () => Promise.resolve(null), afterTurn: () => Promise.resolve([]) },
      sink,
    });
    const queueThreads = {
      ...threads,
      runExclusive: manager.runExclusive.bind(manager),
    } as unknown as TrackThreadService;
    const queuedService = new TrackService({
      prisma,
      workspaces,
      threads: queueThreads,
      memory,
      sink,
      now: () => new Date(NOW),
    });
    let release!: () => void;
    let held!: () => void;
    const entered = new Promise<void>((resolve) => {
      held = resolve;
    });
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = manager.runExclusive(USER, async () => {
      held();
      await blocker;
    });
    await entered;
    const headBefore = await workspaces.git(USER).headSha();
    let settled = false;
    const completing = queuedService.completeDay(USER, 'sql-interview', 1).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(await workspaces.git(USER).headSha()).toBe(headBefore);
    release();
    await holding;
    await completing;
    expect(await prisma.activityEvent.count({ where: { kind: 'commit' } })).toBe(1);
    expect(sink.records.filter((record) => record.event.type === 'memory.commit')).toHaveLength(1);
    manager.close();
  });
});
