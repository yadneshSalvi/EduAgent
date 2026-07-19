/**
 * TrackService owns the SQLite track state machine while keeping every
 * pedagogical fact in the learner's versioned workspace. Database rows make
 * listing/recovery cheap; track.yaml, roadmap.yaml, brief.md, and sources are
 * the truth the tutor reads and changes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient, Thread, Track } from '@prisma/client';
import { dump as yamlDump } from 'js-yaml';
import {
  localDate,
  roadmapFileSchema,
  sessionLogFrontmatterSchema,
  trackFileSchema,
  trackIntakeSchema,
  type RoadmapFile,
  type SessionMode,
  type TrackDetail,
  type TrackIntake,
  type TrackSessions,
  type TrackSummary,
  type ThreadMode,
  type ThreadSummary,
} from '@eduagent/shared';
import type { TrackThreadService, ThreadEventSink } from '../threads/index.js';
import {
  parseFrontmatterFile,
  parseYamlFile,
  type MemoryPipeline,
  type WorkspaceLogger,
  type WorkspaceManager,
} from '../workspace/index.js';

const GENERATING_STALE_MS = 15 * 60_000;
const PLAN_KICKOFF_INPUT = '[plan-roadmap]';
const ACCENTS = ['violet', 'cyan', 'amber', 'rose', 'emerald', 'blue'] as const;

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

export class TrackNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';
  constructor(slug: string) {
    super(`No track "${slug}" exists.`);
    this.name = 'TrackNotFoundError';
  }
}

export class TrackStateError extends Error {
  readonly statusCode = 409;
  readonly code = 'invalid_state';
  constructor(message: string) {
    super(message);
    this.name = 'TrackStateError';
  }
}

export class TrackDayError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_day';
  constructor(message: string) {
    super(message);
    this.name = 'TrackDayError';
  }
}

export class TrackSlugTakenError extends Error {
  readonly statusCode = 409;
  readonly code = 'slug_taken';
  constructor() {
    super('Could not allocate a unique slug after more than 20 collisions.');
    this.name = 'TrackSlugTakenError';
  }
}

export interface TrackServiceDeps {
  prisma: PrismaClient;
  workspaces: WorkspaceManager;
  threads: TrackThreadService;
  memory: Pick<MemoryPipeline, 'emitCommits'>;
  sink: ThreadEventSink;
  logger?: WorkspaceLogger;
  now?: () => Date;
}

export class TrackService {
  private readonly prisma: PrismaClient;
  private readonly workspaces: WorkspaceManager;
  private readonly threads: TrackThreadService;
  private readonly memory: Pick<MemoryPipeline, 'emitCommits'>;
  private readonly sink: ThreadEventSink;
  private readonly logger: WorkspaceLogger;
  private readonly now: () => Date;

  constructor(deps: TrackServiceDeps) {
    this.prisma = deps.prisma;
    this.workspaces = deps.workspaces;
    this.threads = deps.threads;
    this.memory = deps.memory;
    this.sink = deps.sink;
    this.logger = deps.logger ?? noopLogger;
    this.now = deps.now ?? (() => new Date());
  }

  async create(
    userId: string,
    rawIntake: TrackIntake,
  ): Promise<{ track: TrackSummary; planThreadId: string }> {
    const intake = trackIntakeSchema.parse(rawIntake);
    const slug = await this.uniqueSlug(userId, slugify(intake.subject));
    const track = await this.prisma.track.create({
      data: {
        userId,
        slug,
        title: intake.subject,
        goalType: intake.goalType,
        status: 'generating',
        intake: intake as Prisma.InputJsonValue,
        accent: accentFor(slug),
      },
    });

    try {
      const source = sourceFor(intake);
      if (source !== null) {
        await this.threads.runExclusive(userId, async () => {
          await this.workspaces.ensureWorkspace(userId);
          const git = this.workspaces.git(userId);
          const sinceSha = await git.headSha();
          const sourcePath = path.join(
            this.workspaces.pathFor(userId),
            'tracks',
            slug,
            'sources',
            source.filename,
          );
          await fs.mkdir(path.dirname(sourcePath), { recursive: true });
          await fs.writeFile(sourcePath, source.text, 'utf8');
          await git.commitAll(`plan(${slug}): capture source material`);
          await this.memory.emitCommits(userId, sinceSha);
        });
      } else {
        // Planning still needs a workspace, but creation is a workspace write;
        // serialize it with turns for the same staging/checkpoint reason.
        await this.threads.runExclusive(userId, () => this.workspaces.ensureWorkspace(userId));
      }
      const thread = await this.threads.createPlanThread(userId, { trackSlug: slug, intake });
      this.kickoff(track, thread);
      return { track: await this.summaryFor(track), planThreadId: thread.id };
    } catch (err) {
      await this.failGeneration(userId, slug);
      throw err;
    }
  }

  /** Retry generation without changing the stable track slug. */
  async generate(userId: string, slug: string): Promise<{ ok: true; planThreadId: string }> {
    let track = await this.ownedTrack(userId, slug);
    if (track.status !== 'failed') {
      throw new TrackStateError(`Track "${slug}" cannot generate from status "${track.status}".`);
    }
    track = await this.prisma.track.update({
      where: { id: track.id },
      data: { status: 'generating', lastActiveAt: this.now() },
    });
    try {
      const existing = await this.prisma.thread.findFirst({
        where: { userId, mode: 'plan', trackSlug: slug, status: 'active' },
        orderBy: { createdAt: 'desc' },
      });
      const thread =
        existing ??
        (await this.threads.createPlanThread(userId, {
          trackSlug: slug,
          intake: trackIntakeSchema.parse(track.intake),
        }));
      this.kickoff(track, thread);
      return { ok: true, planThreadId: thread.id };
    } catch (err) {
      await this.failGeneration(userId, slug);
      throw err;
    }
  }

  private kickoff(track: Track, thread: Thread): void {
    void this.threads
      .startSystemTurn(thread, PLAN_KICKOFF_INPUT, { caption: 'Drafting your roadmap…' })
      .then(
        () => this.reconcileGeneration(track.userId, track.slug),
        async (err: unknown) => {
          this.logger.warn({ err, track: track.slug }, 'roadmap generation turn failed');
          await this.failGeneration(track.userId, track.slug);
        },
      );
  }

  /** Parses committed plan artifacts after the plan turn settles. */
  async reconcileGeneration(userId: string, slug: string): Promise<void> {
    const track = await this.ownedTrack(userId, slug);
    if (track.status !== 'generating') return; // archive/other terminal action won the race
    const git = this.workspaces.git(userId);
    try {
      const [roadmapRaw, trackRaw] = await Promise.all([
        git.fileAtRef('HEAD', `tracks/${slug}/roadmap.yaml`),
        git.fileAtRef('HEAD', `tracks/${slug}/track.yaml`),
      ]);
      if (roadmapRaw === null || trackRaw === null) throw new Error('plan artifacts are missing');
      const roadmap = parseYamlFile(roadmapFileSchema, roadmapRaw);
      const curriculum = parseYamlFile(trackFileSchema, trackRaw);
      if (roadmap.track !== slug || curriculum.track !== slug) {
        throw new Error('plan artifact track slug does not match its directory');
      }
      const curriculumConcepts = new Set(curriculum.items.map((item) => item.concept));
      const unknownConcepts = unique(
        roadmap.days.flatMap((day) =>
          day.topics.flatMap((topic) =>
            topic.concepts.filter((concept) => !curriculumConcepts.has(concept)),
          ),
        ),
      );
      if (unknownConcepts.length > 0) {
        this.logger.warn(
          { userId, slug, unknownConcepts },
          'roadmap references concepts not yet present in track.yaml',
        );
      }
      const updated = await this.prisma.track.update({
        where: { id: track.id },
        data: { status: 'active', title: curriculum.display_name, lastActiveAt: this.now() },
      });
      this.emitUpdated(updated);
    } catch (err) {
      this.logger.warn({ err, userId, slug }, 'roadmap reconciliation failed');
      await this.failGeneration(userId, slug);
    }
  }

  /** One boot-time recovery pass for generation turns abandoned by a restart. */
  async sweepStaleGenerating(now = this.now()): Promise<number> {
    const cutoff = new Date(now.getTime() - GENERATING_STALE_MS);
    const stale = await this.prisma.track.findMany({
      where: { status: 'generating', lastActiveAt: { lt: cutoff } },
    });
    for (const track of stale) await this.failGeneration(track.userId, track.slug);
    return stale.length;
  }

  async list(userId: string): Promise<TrackSummary[]> {
    const tracks = await this.prisma.track.findMany({
      where: { userId },
      orderBy: { lastActiveAt: 'desc' },
    });
    if (tracks.length === 0) return [];
    const context = await this.modelContext(userId);
    return Promise.all(tracks.map((track) => this.summaryFor(track, context)));
  }

  async detail(userId: string, slug: string): Promise<TrackDetail> {
    const track = await this.ownedTrack(userId, slug);
    const context = await this.modelContext(userId);
    const summary = await this.summaryFor(track, context);
    const roadmap = context.model.roadmaps.find((candidate) => candidate.track === slug) ?? null;
    const curriculum = context.model.tracks.find((candidate) => candidate.track === slug) ?? null;
    const planThread = await this.prisma.thread.findFirst({
      where: { userId, mode: 'plan', trackSlug: slug },
      orderBy: { createdAt: 'desc' },
    });
    if (roadmap === null) {
      return {
        ...summary,
        targetDate: curriculum?.target_date ?? intakeTargetDate(track),
        planThreadId: planThread?.id ?? null,
        roadmap: null,
        headDay: null,
        subtopicsDone: 0,
        subtopicsTotal: 0,
      };
    }

    const [threads, logs] = await Promise.all([
      this.prisma.thread.findMany({
        where: { userId, trackSlug: slug, mode: 'learn', roadmapDay: { not: null } },
        select: { roadmapDay: true },
      }),
      this.sessionLogs(userId, slug),
    ]);
    const counts = new Map<number, number>();
    for (const thread of threads) {
      if (thread.roadmapDay !== null)
        counts.set(thread.roadmapDay, (counts.get(thread.roadmapDay) ?? 0) + 1);
    }
    for (const log of logs) {
      if (log.roadmapDay !== null)
        counts.set(log.roadmapDay, (counts.get(log.roadmapDay) ?? 0) + 1);
    }
    const dates = plannedDates(roadmap, context.today);
    const headDay = roadmap.days.find((day) => day.status === 'upcoming')?.day ?? null;
    return {
      ...summary,
      targetDate: curriculum?.target_date ?? intakeTargetDate(track),
      planThreadId: planThread?.id ?? null,
      roadmap: {
        schedule: roadmap.schedule,
        days: roadmap.days.map((day) => ({
          day: day.day,
          title: day.title,
          status: day.status,
          completedOn: day.completed_on ?? null,
          plannedDate: day.status === 'upcoming' ? (dates.get(day.day) ?? null) : null,
          topics: day.topics,
          subtopics: day.subtopics,
          sessionCount: counts.get(day.day) ?? 0,
        })),
      },
      headDay,
      subtopicsDone: roadmap.days
        .filter((day) => day.status === 'complete')
        .reduce((sum, day) => sum + day.subtopics.length, 0),
      subtopicsTotal: roadmap.days.reduce((sum, day) => sum + day.subtopics.length, 0),
    };
  }

  async sessions(userId: string, slug: string): Promise<TrackSessions> {
    await this.ownedTrack(userId, slug);
    const [threads, events, logs] = await Promise.all([
      this.prisma.thread.findMany({
        where: { userId, trackSlug: slug, mode: 'learn', roadmapDay: { not: null } },
        orderBy: { lastActiveAt: 'desc' },
      }),
      this.prisma.activityEvent.findMany({
        where: { userId, kind: 'commit' },
        select: { meta: true },
      }),
      this.sessionLogs(userId, slug),
    ]);
    const commits = new Map<string, number>();
    for (const event of events) {
      const meta = event.meta;
      if (isRecord(meta) && typeof meta.threadId === 'string') {
        commits.set(meta.threadId, (commits.get(meta.threadId) ?? 0) + 1);
      }
    }
    const merged: Array<{ sort: number; value: TrackSessions['sessions'][number] }> = [
      ...threads.map((thread) => ({
        sort: thread.lastActiveAt.getTime(),
        value: {
          kind: 'thread' as const,
          thread: toThreadSummary(thread),
          roadmapDay: thread.roadmapDay!,
          commitCount: commits.get(thread.id) ?? 0,
        },
      })),
      ...logs.map((log) => ({
        sort: Date.parse(`${log.date}T12:00:00Z`),
        value: {
          kind: 'log' as const,
          file: log.file,
          date: log.date,
          title: log.title,
          roadmapDay: log.roadmapDay,
          durationEstimate: log.durationEstimate,
          mode: log.mode,
        },
      })),
    ];
    return { sessions: merged.sort((a, b) => b.sort - a.sort).map((entry) => entry.value) };
  }

  async completeDay(
    userId: string,
    slug: string,
    dayNumber: number,
    opts: { threadId?: string } = {},
  ): Promise<TrackDetail> {
    await this.ownedTrack(userId, slug);
    await this.threads.runExclusive(userId, async () => {
      const track = await this.ownedTrack(userId, slug);
      const git = this.workspaces.git(userId);
      const roadmapPath = `tracks/${slug}/roadmap.yaml`;
      const raw = await git.fileAtRef('HEAD', roadmapPath);
      if (raw === null) throw new TrackStateError(`Track "${slug}" has no committed roadmap.`);
      const roadmap = parseYamlFile(roadmapFileSchema, raw);
      const day = roadmap.days.find((candidate) => candidate.day === dayNumber);
      if (!day) throw new TrackStateError(`Roadmap day ${dayNumber} does not exist.`);
      if (day.status === 'complete') return; // idempotent, including a completed track
      if (track.status !== 'active') {
        throw new TrackStateError(
          `Track "${slug}" cannot complete a day from status "${track.status}".`,
        );
      }
      const context = await this.modelContext(userId);
      const sinceSha = await git.headSha();
      day.status = 'complete';
      day.completed_on = context.today;
      const reflowed = roadmap.days.filter((candidate) => candidate.status === 'upcoming').length;
      await fs.writeFile(
        path.join(this.workspaces.pathFor(userId), roadmapPath),
        yamlDump(roadmap, { noRefs: true, lineWidth: -1 }),
        'utf8',
      );
      const message = [
        `plan(${slug}): day ${dayNumber} complete — ${day.title}`,
        '',
        `- Covered: ${day.subtopics.join('; ')}`,
        ...(reflowed > 0 ? [`- Reflowed ${reflowed} days from ${context.today}`] : []),
      ].join('\n');
      await git.commitAll(message);
      const allComplete = roadmap.days.every((candidate) => candidate.status === 'complete');
      const updated = await this.prisma.track.update({
        where: { id: track.id },
        data: { status: allComplete ? 'completed' : 'active', lastActiveAt: this.now() },
      });
      await this.memory.emitCommits(userId, sinceSha, opts);
      this.emitUpdated(updated);
    });
    return this.detail(userId, slug);
  }

  async createSession(
    userId: string,
    slug: string,
    opts: { day: number; intent: 'teach' | 'revise' | 'mistakes' },
  ): Promise<Thread> {
    const track = await this.ownedTrack(userId, slug);
    if (track.status !== 'active' && track.status !== 'completed') {
      throw new TrackStateError(
        `Track "${slug}" cannot start a session from status "${track.status}".`,
      );
    }
    const model = await this.workspaces.readLearnerModel(userId);
    const roadmap = model.roadmaps.find((candidate) => candidate.track === slug);
    if (!roadmap?.days.some((day) => day.day === opts.day)) {
      throw new TrackDayError(`Roadmap day ${opts.day} does not exist.`);
    }
    const thread = await this.threads.createTrackSession(userId, {
      trackSlug: slug,
      day: opts.day,
      intent: opts.intent,
    });
    await this.prisma.track.update({ where: { id: track.id }, data: { lastActiveAt: this.now() } });
    return thread;
  }

  async archive(userId: string, slug: string): Promise<void> {
    const track = await this.ownedTrack(userId, slug);
    const updated = await this.prisma.track.update({
      where: { id: track.id },
      data: { status: 'archived', lastActiveAt: this.now() },
    });
    this.emitUpdated(updated);
  }

  private async ownedTrack(userId: string, slug: string): Promise<Track> {
    const track = await this.prisma.track.findUnique({
      where: { userId_slug: { userId, slug } },
    });
    if (!track) throw new TrackNotFoundError(slug);
    return track;
  }

  private async setStatus(track: Track, status: TrackSummary['status']): Promise<Track> {
    const updated = await this.prisma.track.update({
      where: { id: track.id },
      data: { status, lastActiveAt: this.now() },
    });
    this.emitUpdated(updated);
    return updated;
  }

  /** Failure is conditional so an archive racing a settling turn always wins. */
  private async failGeneration(userId: string, slug: string): Promise<void> {
    const current = await this.ownedTrack(userId, slug);
    if (current.status !== 'generating') return;
    await this.setStatus(current, 'failed');
  }

  private emitUpdated(track: Track): void {
    this.sink.emitToUser(track.userId, {
      type: 'track.updated',
      slug: track.slug,
      status: track.status as TrackSummary['status'],
    });
  }

  private async uniqueSlug(userId: string, requested: string): Promise<string> {
    for (let collision = 0; collision <= 20; collision++) {
      const candidate = collision === 0 ? requested : `${requested}-${collision + 1}`;
      const existing = await this.prisma.track.findUnique({
        where: { userId_slug: { userId, slug: candidate } },
        select: { id: true },
      });
      if (!existing) return candidate;
    }
    throw new TrackSlugTakenError();
  }

  private async modelContext(userId: string): Promise<{
    model: Awaited<ReturnType<WorkspaceManager['readLearnerModel']>>;
    today: string;
  }> {
    const [model, user] = await Promise.all([
      this.workspaces.readLearnerModel(userId),
      this.prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
    ]);
    const timezone = model.profile?.frontmatter.timezone ?? user?.timezone ?? 'UTC';
    return { model, today: localDate(this.now(), timezone) };
  }

  private async summaryFor(
    track: Track,
    supplied?: Awaited<ReturnType<TrackService['modelContext']>>,
  ): Promise<TrackSummary> {
    const context = supplied ?? (await this.modelContext(track.userId));
    const roadmap = context.model.roadmaps.find((candidate) => candidate.track === track.slug);
    const curriculum = context.model.tracks.find((candidate) => candidate.track === track.slug);
    const head = roadmap?.days.find((day) => day.status === 'upcoming')?.day;
    const dates = roadmap ? plannedDates(roadmap, context.today) : new Map<number, string>();
    return {
      id: track.id,
      slug: track.slug,
      title: track.title,
      goalType: track.goalType as TrackSummary['goalType'],
      status: track.status as TrackSummary['status'],
      accent: track.accent,
      createdAt: track.createdAt.toISOString(),
      lastActiveAt: track.lastActiveAt.toISOString(),
      day: roadmap && head ? { head, total: roadmap.days.length } : null,
      completedDays:
        roadmap?.days.filter((day) => day.status === 'complete').map((day) => day.day) ?? [],
      nextPlannedDate: head ? (dates.get(head) ?? null) : null,
      conceptSlugs: unique(curriculum?.items.map((item) => item.concept) ?? []),
      topicSlugs: unique(curriculum?.items.map((item) => item.topic) ?? []),
    };
  }

  private async sessionLogs(
    userId: string,
    trackSlug: string,
  ): Promise<
    Array<{
      file: string;
      date: string;
      title: string;
      roadmapDay: number | null;
      durationEstimate: string | number;
      mode: SessionMode;
    }>
  > {
    const dir = this.workspaces.pathFor(userId);
    const git = this.workspaces.git(userId);
    const files = new Set(
      (await git.lsFiles()).filter((file) => /^sessions\/[^/]+\.md$/.test(file)),
    );
    try {
      for (const file of await fs.readdir(path.join(dir, 'sessions'))) {
        if (file.endsWith('.md')) files.add(`sessions/${file}`);
      }
    } catch {
      // no session directory yet
    }
    const result: Array<{
      file: string;
      date: string;
      title: string;
      roadmapDay: number | null;
      durationEstimate: string | number;
      mode: SessionMode;
    }> = [];
    for (const file of files) {
      let raw: string | null = null;
      try {
        raw = await fs.readFile(path.join(dir, file), 'utf8');
      } catch {
        raw = await git.fileAtRef('HEAD', file);
      }
      if (raw === null) continue;
      try {
        const parsed = parseFrontmatterFile(sessionLogFrontmatterSchema, raw).frontmatter;
        if (parsed.track !== trackSlug) continue;
        result.push({
          file,
          date: parsed.date,
          title: parsed.title ?? humanizeSessionFilename(file),
          roadmapDay: parsed.roadmap_day ?? null,
          durationEstimate: parsed.duration_estimate,
          mode: parsed.mode,
        });
      } catch {
        // Invalid logs stay on the normal repair path and cannot back a row.
      }
    }
    return result;
  }
}

/** Lowercase kebab slug without a dependency; non-Latin-only titles fall back safely. */
export function slugify(value: string): string {
  return (
    value
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'track'
  );
}

function sourceFor(intake: TrackIntake): { filename: string; text: string } | null {
  if (intake.sourceText?.trim()) {
    return {
      filename: intake.sourceKind === 'job-description' ? 'job-description.md' : 'syllabus.md',
      text: intake.sourceText,
    };
  }
  if (intake.subtopics?.trim()) return { filename: 'self-described.md', text: intake.subtopics };
  return null;
}

function accentFor(slug: string): string {
  let hash = 0;
  for (const char of slug) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return ACCENTS[hash % ACCENTS.length]!;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function intakeTargetDate(track: Track): string | null {
  const parsed = trackIntakeSchema.safeParse(track.intake);
  return parsed.success ? (parsed.data.targetDate ?? null) : null;
}

function plannedDates(roadmap: RoadmapFile, today: string): Map<number, string> {
  const result = new Map<number, string>();
  const allowed = new Set(roadmap.schedule.study_days.map((day) => weekdayNumber(day)));
  let cursor = maxIso(roadmap.schedule.start_date, today);
  for (const day of roadmap.days) {
    if (day.status === 'complete') continue;
    while (!allowed.has(utcWeekday(cursor))) cursor = addIsoDay(cursor, 1);
    result.set(day.day, cursor);
    cursor = addIsoDay(cursor, 1);
  }
  return result;
}

function weekdayNumber(day: RoadmapFile['schedule']['study_days'][number]): number {
  return { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[day];
}

function utcWeekday(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function addIsoDay(iso: string, amount: number): string {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

const maxIso = (left: string, right: string): string => (left > right ? left : right);

function humanizeSessionFilename(file: string): string {
  const name = path.basename(file, '.md').replace(/^\d{4}-\d{2}-\d{2}-/, '');
  const words = name.replace(/-/g, ' ');
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : 'Learning session';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toThreadSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    mode: thread.mode as ThreadMode,
    topicSlug: thread.topicSlug,
    trackSlug: thread.trackSlug,
    roadmapDay: thread.roadmapDay,
    intent: thread.intent as ThreadSummary['intent'],
    title: thread.title,
    status: thread.status as ThreadSummary['status'],
    forkedFromId: thread.forkedFromId,
    createdAt: thread.createdAt.toISOString(),
    lastActiveAt: thread.lastActiveAt.toISOString(),
  };
}
