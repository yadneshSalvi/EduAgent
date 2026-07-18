/**
 * DashboardService (plans/03 §3.5): builds the whole `DashboardData` payload
 * (plans/02 §6) from one user's workspace — learner-model files via
 * WorkspaceManager, git history via GitService + parseCommit, learning-math
 * for every derived number — with a per-user in-memory cache invalidated on
 * memory commits (boot wires MemoryPipeline.onMemoryChanged → invalidate).
 *
 * Method notes (the parts the plan leaves open):
 * - `delta7d`: current readiness minus readiness at the newest commit dated
 *   ≤ now-7d, with the track/mastery files READ AT THAT REF and decay
 *   evaluated at now-7d. No commit that old (workspace younger than 7 days)
 *   → baseline 0, so delta7d = current score.
 * - `decaySeries`: past points reconstructed from parsed commit-headline
 *   deltas (each `concept A→B` in a commit dated D is an assessment anchor
 *   (D, B)), closed by the current (last_assessed, mastery) anchor; between
 *   anchors the value follows the decay curve. review_count per segment is
 *   approximated as current review_count minus the number of later anchors
 *   (floored at 0). Series spans the last 30 days plus a 14-day projection;
 *   "interesting" = largest raw→effective gap, +0.15 bonus when assessed in
 *   the last 7 days (recently boosted), top 6.
 * - `streak`/`activity`/"today" use the learner's timezone: profile.md's when
 *   present (the learner told the tutor), else the User row's, else UTC.
 */
import type { PrismaClient } from '@prisma/client';
import { load as yamlLoad } from 'js-yaml';
import {
  addDays,
  decayed,
  effectiveMastery,
  isFading,
  localDate,
  masteryFileSchema,
  readinessScore,
  streakDays,
  trackFileSchema,
  type DashboardData,
  type MasteryFile,
  type TimelineEntry,
} from '@eduagent/shared';
import { TURN_START_EVENT } from '../threads/index.js';
import type { GitService, GitCommitInfo } from '../workspace/GitService.js';
import { parseCommit } from '../workspace/GitService.js';
import type { LearnerModel, WorkspaceLogger, WorkspaceManager } from '../workspace/index.js';
import { dueSummary } from './SrsEngine.js';

const MS_PER_DAY = 86_400_000;

/** Dashboard timeline cap — the full journal pages through /api/memory/log. */
const TIMELINE_LIMIT = 50;
const ACTIVITY_DAYS = 90;
const WEAKEST_COUNT = 5;
const NEXT_CONCEPTS_MAX = 5;
const DECAY_SERIES_MAX = 6;
const DECAY_PAST_DAYS = 30;
const DECAY_PROJECTION_DAYS = 14;
/** An assessment within this window marks a concept "recently boosted". */
const RECENT_BOOST_DAYS = 7;
const RECENT_BOOST_BONUS = 0.15;
const CACHE_TTL_MS = 5 * 60_000;

/** A timeline entry plus its parsed instant (for streak/baseline math). */
interface DatedEntry extends TimelineEntry {
  instantMs: number;
}

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

export interface DashboardServiceDeps {
  prisma: PrismaClient;
  workspaces: WorkspaceManager;
  logger?: WorkspaceLogger;
  cacheTtlMs?: number;
}

export class DashboardService {
  private readonly prisma: PrismaClient;
  private readonly workspaces: WorkspaceManager;
  private readonly logger: WorkspaceLogger;
  private readonly cacheTtlMs: number;

  private readonly cache = new Map<string, { data: DashboardData; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<DashboardData>>();
  /** Bumped by invalidate() so an in-flight build can't cache stale data. */
  private readonly generations = new Map<string, number>();

  constructor(deps: DashboardServiceDeps) {
    this.prisma = deps.prisma;
    this.workspaces = deps.workspaces;
    this.logger = deps.logger ?? noopLogger;
    this.cacheTtlMs = deps.cacheTtlMs ?? CACHE_TTL_MS;
  }

  /**
   * The dashboard payload, cached per user. Passing an explicit `now`
   * (tests, deterministic builds) bypasses the cache entirely.
   */
  async get(userId: string, opts: { now?: Date } = {}): Promise<DashboardData> {
    if (opts.now !== undefined) return this.build(userId, opts.now);
    const hit = this.cache.get(userId);
    if (hit !== undefined && hit.expiresAt > Date.now()) return hit.data;
    const inFlight = this.pending.get(userId);
    if (inFlight !== undefined) return inFlight;
    const generation = this.generations.get(userId) ?? 0;
    const promise = this.build(userId, new Date())
      .then((data) => {
        if ((this.generations.get(userId) ?? 0) === generation) {
          this.cache.set(userId, { data, expiresAt: Date.now() + this.cacheTtlMs });
        }
        return data;
      })
      .finally(() => this.pending.delete(userId));
    this.pending.set(userId, promise);
    return promise;
  }

  /** Called on memory commits (boot wiring) — next get() rebuilds. */
  invalidate(userId: string): void {
    this.generations.set(userId, (this.generations.get(userId) ?? 0) + 1);
    this.cache.delete(userId);
  }

  // ------------------------------------------------------------------ build

  private async build(userId: string, now: Date): Promise<DashboardData> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) throw new Error(`DashboardService: no such user ${userId}`);

    if (!this.workspaces.hasWorkspace(userId)) {
      // Authed but never onboarded: an empty-but-valid dashboard, no writes.
      const today = localDate(now, user.timezone);
      return {
        user: { displayName: user.displayName, streakDays: 0 },
        readiness: [],
        topics: [],
        decaySeries: [],
        timeline: [],
        reviewQueue: { dueToday: 0, overdue: 0, nextConcepts: [] },
        activity: this.zeroActivity(today),
      };
    }

    const model = await this.workspaces.readLearnerModel(userId);
    const git = this.workspaces.git(userId);
    const entries = toDatedEntries(await git.log());
    const timezone = model.profile?.frontmatter.timezone ?? user.timezone ?? 'UTC';
    const today = localDate(now, timezone);

    const streak = streakDays(
      entries
        .filter((e) => e.type === 'learn' || e.type === 'review' || e.type === 'exam')
        .map((e) => e.date),
      timezone,
      now,
    );

    const concepts = indexConcepts(model, now);
    const topics = buildTopics(model, concepts);
    const readiness = await this.buildReadiness(git, model, entries, concepts, now);
    const decaySeries = buildDecaySeries(model, entries, now, today);
    const reviewQueue = buildReviewQueue(model, today);
    const activity = await this.buildActivity(userId, timezone, today, now);
    const continueCta = buildContinueCta(model);

    return {
      user: { displayName: user.displayName, streakDays: streak },
      ...(continueCta !== null ? { continueCta } : {}),
      readiness,
      topics,
      decaySeries,
      timeline: entries.slice(0, TIMELINE_LIMIT).map(stripInstant),
      reviewQueue,
      activity,
    };
  }

  // -------------------------------------------------------------- readiness

  private async buildReadiness(
    git: GitService,
    model: LearnerModel,
    entries: DatedEntry[],
    concepts: ConceptIndex,
    now: Date,
  ): Promise<DashboardData['readiness']> {
    const cutoff = new Date(now.getTime() - 7 * MS_PER_DAY);
    // entries are newest-first: the first at-or-before the cutoff is the ref
    // whose files describe the learner as they were 7 days ago.
    const baselineSha = entries.find((e) => e.instantMs <= cutoff.getTime())?.sha ?? null;
    const baselineMastery = new Map<string, MasteryFile | null>();

    const result: DashboardData['readiness'] = [];
    for (const track of model.tracks) {
      const items = track.items.map((item) => {
        const concept = concepts.get(`${item.topic}/${item.concept}`);
        return {
          concept: item.concept,
          name: concept?.name ?? item.concept,
          weight: item.weight,
          effective: concept?.effective ?? 0,
        };
      });
      const score = readinessScore(items);

      let baseline = 0;
      if (baselineSha !== null) {
        baseline = await this.baselineReadiness(
          git,
          baselineSha,
          track.track,
          baselineMastery,
          cutoff,
        );
      }

      // "Weakest" per plans/02 §4: bottom 5 by WEIGHTED effective mastery —
      // untracked concepts (effective 0) sort first, exactly what exam mode attacks.
      const weakest = [...items]
        .sort(
          (a, b) =>
            a.weight * a.effective - b.weight * b.effective || a.concept.localeCompare(b.concept),
        )
        .slice(0, WEAKEST_COUNT)
        .map(({ concept, name, effective }) => ({ concept, name, effective }));

      result.push({
        track: track.track,
        displayName: track.display_name,
        score,
        delta7d: score - baseline,
        ...(track.target_date !== undefined ? { targetDate: track.target_date } : {}),
        weakest,
      });
    }
    return result;
  }

  /** Readiness for one track as of `cutoff`, from the files at `sha`. */
  private async baselineReadiness(
    git: GitService,
    sha: string,
    trackSlug: string,
    masteryCache: Map<string, MasteryFile | null>,
    cutoff: Date,
  ): Promise<number> {
    const track = await this.fileAt(git, sha, `tracks/${trackSlug}.yaml`, trackFileSchema);
    if (track === null) return 0;
    const items = [];
    for (const item of track.items) {
      let mastery = masteryCache.get(item.topic);
      if (mastery === undefined) {
        mastery = await this.fileAt(
          git,
          sha,
          `topics/${item.topic}/mastery.yaml`,
          masteryFileSchema,
        );
        masteryCache.set(item.topic, mastery);
      }
      const concept = mastery?.concepts.find((c) => c.id === item.concept);
      items.push({
        weight: item.weight,
        effective: concept
          ? effectiveMastery(concept.mastery, concept.review_count, concept.last_assessed, cutoff)
          : 0,
      });
    }
    return readinessScore(items);
  }

  private async fileAt<T>(
    git: GitService,
    sha: string,
    relPath: string,
    schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
  ): Promise<T | null> {
    const raw = await git.fileAtRef(sha, relPath);
    if (raw === null) return null;
    try {
      const parsed = schema.safeParse(yamlLoad(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- activity

  private async buildActivity(
    userId: string,
    timezone: string,
    today: string,
    now: Date,
  ): Promise<DashboardData['activity']> {
    const events = await this.prisma.activityEvent.findMany({
      // turn_start rows are quota bookkeeping (ThreadManager) — counting them
      // here would roughly double the heatmap on hosted days vs. seeded ones.
      where: {
        userId,
        kind: { not: TURN_START_EVENT },
        at: { gte: new Date(now.getTime() - (ACTIVITY_DAYS + 1) * MS_PER_DAY) },
      },
      select: { at: true },
    });
    const counts = new Map<string, number>();
    for (const event of events) {
      const day = localDate(event.at, timezone);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    const strip: DashboardData['activity'] = [];
    for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
      const date = addDays(today, -i);
      strip.push({ date, count: counts.get(date) ?? 0 });
    }
    return strip;
  }

  private zeroActivity(today: string): DashboardData['activity'] {
    const strip: DashboardData['activity'] = [];
    for (let i = ACTIVITY_DAYS - 1; i >= 0; i--) {
      strip.push({ date: addDays(today, -i), count: 0 });
    }
    return strip;
  }
}

// ---------------------------------------------------------------- helpers

type ConceptIndex = Map<
  string,
  { name: string; mastery: number; effective: number; reviewCount: number; lastAssessed: string }
>;

/** Effective mastery per `topic/concept`, computed once per build. */
function indexConcepts(model: LearnerModel, now: Date): ConceptIndex {
  const index: ConceptIndex = new Map();
  for (const topic of model.topics) {
    for (const concept of topic.mastery?.concepts ?? []) {
      index.set(`${topic.topic}/${concept.id}`, {
        name: concept.name,
        mastery: concept.mastery,
        effective: effectiveMastery(
          concept.mastery,
          concept.review_count,
          concept.last_assessed,
          now,
        ),
        reviewCount: concept.review_count,
        lastAssessed: concept.last_assessed,
      });
    }
  }
  return index;
}

function buildTopics(model: LearnerModel, concepts: ConceptIndex): DashboardData['topics'] {
  return model.topics
    .filter((topic) => topic.mastery !== null)
    .map((topic) => ({
      topic: topic.topic,
      displayName: topic.displayName,
      concepts: (topic.mastery?.concepts ?? []).map((concept) => {
        const state = concepts.get(`${topic.topic}/${concept.id}`);
        const effective = state?.effective ?? concept.mastery;
        return {
          id: concept.id,
          name: concept.name,
          mastery: concept.mastery,
          effective,
          fading: isFading(concept.mastery, effective),
          lastAssessed: concept.last_assessed,
          reviewCount: concept.review_count,
        };
      }),
    }));
}

function buildReviewQueue(model: LearnerModel, today: string): DashboardData['reviewQueue'] {
  const summary = dueSummary(model.srs, today);
  return {
    dueToday: summary.dueToday,
    overdue: summary.overdue,
    nextConcepts: summary.due.slice(0, NEXT_CONCEPTS_MAX).map((item) => item.concept),
  };
}

function buildContinueCta(model: LearnerModel): DashboardData['continueCta'] | null {
  const session = model.lastSession;
  const label = session?.frontmatter.next_time;
  const topicSlug = session?.frontmatter.topics[0];
  if (label === undefined || topicSlug === undefined) return null;
  return { label, topicSlug };
}

/**
 * Parses commits into timeline entries. Non-grammar commits map like the
 * MemoryPipeline does (type system, topic general) so the journal stays
 * complete; dates normalize to ISO. Unparseable dates are dropped entirely —
 * they can't participate in any time math.
 */
function toDatedEntries(log: GitCommitInfo[]): DatedEntry[] {
  const entries: DatedEntry[] = [];
  for (const info of log) {
    const instantMs = Date.parse(info.date);
    if (Number.isNaN(instantMs)) continue;
    const parsed = parseCommit(info.message);
    entries.push({
      sha: info.sha,
      type: parsed?.type ?? 'system',
      topic: parsed?.topic ?? 'general',
      headline: parsed?.headline ?? (info.message.split('\n')[0] || '(empty commit message)'),
      bullets: parsed?.bullets ?? [],
      deltas: parsed?.deltas ?? [],
      date: new Date(instantMs).toISOString(),
      instantMs,
    });
  }
  return entries;
}

function stripInstant(entry: DatedEntry): TimelineEntry {
  const { instantMs: _instantMs, ...rest } = entry;
  return rest;
}

/** See the class doc-comment for the reconstruction method. */
function buildDecaySeries(
  model: LearnerModel,
  entries: DatedEntry[],
  now: Date,
  today: string,
): DashboardData['decaySeries'] {
  interface Candidate {
    concept: string;
    name: string;
    interest: number;
    points: Array<{ date: string; effective: number }>;
  }
  const oldestFirst = [...entries].reverse();
  const candidates: Candidate[] = [];

  for (const topic of model.topics) {
    for (const concept of topic.mastery?.concepts ?? []) {
      const anchorTime = Date.parse(concept.last_assessed);
      if (Number.isNaN(anchorTime)) continue;

      // Assessment anchors: headline deltas for this concept, then the
      // current state. Same-day (or later-dated) deltas collapse into the
      // current anchor so today's value always equals the live effective.
      const anchors: Array<{ time: number; value: number }> = [];
      for (const entry of oldestFirst) {
        if (entry.topic !== topic.topic) continue;
        for (const delta of entry.deltas) {
          if (delta.concept === concept.id && entry.instantMs < anchorTime) {
            anchors.push({ time: entry.instantMs, value: delta.to });
          }
        }
      }
      anchors.push({ time: anchorTime, value: concept.mastery });

      const reviewCountAt = (segment: number): number =>
        Math.max(0, concept.review_count - (anchors.length - 1 - segment));

      const firstDay = new Date(anchors[0]!.time).toISOString().slice(0, 10);
      const startDay = maxIso(firstDay, addDays(today, -DECAY_PAST_DAYS));
      const endDay = addDays(today, DECAY_PROJECTION_DAYS);
      const points: Array<{ date: string; effective: number }> = [];
      for (let day = startDay; day <= endDay; day = addDays(day, 1)) {
        const t = Date.parse(`${day}T00:00:00Z`);
        let segment = -1;
        for (let i = anchors.length - 1; i >= 0; i--) {
          if (anchors[i]!.time <= t) {
            segment = i;
            break;
          }
        }
        if (segment === -1) continue; // before the first assessment
        const anchor = anchors[segment]!;
        const days = (t - anchor.time) / MS_PER_DAY;
        const value = decayed(anchor.value, reviewCountAt(segment), days);
        points.push({ date: day, effective: Math.min(1, Math.max(0, value)) });
      }
      if (points.length === 0) continue;

      const effectiveNow = effectiveMastery(
        concept.mastery,
        concept.review_count,
        concept.last_assessed,
        now,
      );
      const recentlyBoosted = anchorTime >= now.getTime() - RECENT_BOOST_DAYS * MS_PER_DAY;
      candidates.push({
        concept: concept.id,
        name: concept.name,
        interest: concept.mastery - effectiveNow + (recentlyBoosted ? RECENT_BOOST_BONUS : 0),
        points,
      });
    }
  }

  return candidates
    .sort((a, b) => b.interest - a.interest || a.concept.localeCompare(b.concept))
    .slice(0, DECAY_SERIES_MAX)
    .map(({ concept, name, points }) => ({ concept, name, points }));
}

const maxIso = (a: string, b: string): string => (a > b ? a : b);
