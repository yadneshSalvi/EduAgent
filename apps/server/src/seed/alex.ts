import fs from 'node:fs/promises';
import path from 'node:path';
import {
  addDays,
  effectiveMastery,
  readinessScore,
  roadmapFileSchema,
  type RoadmapFile,
} from '@eduagent/shared';
import { dump as yamlDump } from 'js-yaml';
import type { ExamTarget } from '../learning/exam-config.js';
import { GitService, parseCommit } from '../workspace/GitService.js';
import { ALEX_EXAM_QUESTIONS } from './exam-row.js';
import { WORKSPACE_INIT_COMMIT, WORKSPACE_TEMPLATE } from '../workspace/template.js';
import {
  EXAM_EVIDENCE_BULLETS,
  FILLER_HEADLINES,
  FILLER_NOTES,
  GENERIC_LEARN_BULLETS,
  GENERIC_REVIEW_BULLETS,
  MISCONCEPTIONS,
  ROADMAPS,
  SESSIONS,
  SESSION_WRAP_HEADLINES,
  TOPICS,
  TRACKS,
  type ArcStep,
  type ConceptSeed,
  type MisconceptionSeed,
  type RoadmapDaySeed,
  type RoadmapSeed,
  type SessionSeed,
  type TrackSeed,
} from './content.js';
import { mulberry32, pick, randInt, VariedPicker, type Rng } from './rng.js';
import { SeedClock } from './time.js';

/**
 * Generates Alex's ~21-day workspace history (plans/02 §7): ~140 backdated,
 * grammar-valid commits telling the joins-struggle→breakthrough→mock-exam
 * story, with files that are zod-valid at every commit. Deterministic: same
 * (now, rngSeed) → same history, byte for byte.
 */

export const ALEX_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_RNG_SEED = 0xed0a6e47;
/** Extra no-assessment commits per day (notes-only recall checks). */
const FILLER_COUNTS: Record<number, number> = {
  20: 2,
  19: 2,
  18: 1,
  16: 2,
  15: 1,
  12: 1,
  11: 1,
  6: 1,
  3: 1,
  1: 1,
  0: 2,
};
const MAX_EVIDENCE = 4;
/** Deltas shown in the exam commit headline (the rest ride in the body). */
const EXAM_HEADLINE_DELTAS = 5;
const EXAM_SCORE = '71/100';

const PROFILE_BODY = [
  'Alex is a mid-level frontend dev moving to backend. Strong JS fundamentals,',
  'rusty SQL, no formal CS background. Learns best from concrete examples first,',
  'theory second. Gets discouraged by long lectures — keep chunks small and',
  'hands-on. Responds well to being shown row counts instead of being told rules.',
].join('\n');

const PROFILE_PYTHON_NOTE = [
  '',
  'Week-2 addition: the target roles all include a DS&A screen, so a Python',
  'data-structures track now runs alongside SQL — short morning blocks so it',
  'never crowds out the primary track.',
].join('\n');

export interface SeededCommit {
  sha: string;
  instant: Date;
  type: string;
  topic: string;
  headline: string;
  bullets: string[];
  deltas: Array<{ concept: string; from: number; to: number }>;
}

export interface AlexSeedResult {
  commits: SeededCommit[];
  sessions: SeededSessionResult[];
  /**
   * Track readiness at the exam moment, before/after grading (1dp), plus the
   * weakest-at-exam targeting — seed.ts mirrors these into the graded Exam DB
   * row so /app/exam History matches the workspace record.
   */
  exam: { before: number; after: number; delta: number; targeting: ExamTarget[] };
  today: string;
}

export interface SeededSessionResult {
  session: SessionSeed;
  startedAt: Date;
  endedAt: Date;
  commitSha: string;
  summaryMd: string;
  conceptDeltas: Array<{ topic: string; concept: string; from: number; to: number }>;
}

// ---------------------------------------------------------------------------
// Evolving state
// ---------------------------------------------------------------------------

interface SrsState {
  interval: number;
  ease: number;
  lapses: number;
  due: string;
}

interface ConceptState {
  spec: ConceptSeed;
  topic: string;
  mastery: number;
  lastAssessed: string;
  reviewCount: number;
  evidence: Array<{ date: string; note: string }>;
  srs: SrsState | null;
  stepIdx: number;
}

interface MiscState {
  spec: MisconceptionSeed;
  status: 'open' | 'resolved';
  firstSeen: string;
  resolvedOn?: string;
  evidence: string;
}

type SeedEvent =
  | { kind: 'init'; day: number; order: number }
  | { kind: 'onboarding'; day: number; order: number }
  | { kind: 'source'; day: number; order: number; roadmap: RoadmapSeed }
  | { kind: 'roadmap-birth'; day: number; order: number; roadmap: RoadmapSeed }
  | {
      kind: 'roadmap-complete';
      day: number;
      order: number;
      roadmap: RoadmapSeed;
      roadmapDay: RoadmapDaySeed;
    }
  | { kind: 'track-add'; day: number; order: number }
  | {
      kind: 'assess';
      day: number;
      order: number;
      topic: string;
      steps: Array<{ concept: ConceptSeed; step: ArcStep }>;
    }
  | {
      kind: 'exam';
      day: number;
      order: number;
      steps: Array<{ concept: ConceptSeed; step: ArcStep }>;
    }
  | { kind: 'misc-open'; day: number; order: number; misc: MisconceptionSeed }
  | { kind: 'filler'; day: number; order: number; topic: string }
  | { kind: 'wrap'; day: number; order: number; session: SessionSeed };

// ---------------------------------------------------------------------------

export async function seedAlexWorkspace(
  dir: string,
  now: Date,
  opts: { rngSeed?: number } = {},
): Promise<AlexSeedResult> {
  const rng = mulberry32(opts.rngSeed ?? DEFAULT_RNG_SEED);
  const clock = new SeedClock(now, ALEX_TIMEZONE);
  await fs.mkdir(dir, { recursive: true }); // simple-git requires an existing dir
  const gen = new AlexGenerator(dir, clock, rng);
  return gen.run();
}

class AlexGenerator {
  private readonly git: GitService;
  private readonly concepts = new Map<string, ConceptState>(); // "topic/id"
  private readonly miscs = new Map<string, MiscState>();
  private readonly notes = new Map<string, string[]>(); // topic → lines
  private readonly roadmaps = new Map<string, RoadmapFile>();
  private readonly commits: SeededCommit[] = [];
  private readonly sessions: SeededSessionResult[] = [];
  private readonly learnPicker: VariedPicker;
  private readonly reviewPicker: VariedPicker;
  private readonly fillerNotePicker: VariedPicker;
  private profileTracks: string[] = ['sql-interview'];
  private profileBody = PROFILE_BODY;
  private exerciseNo = 0;
  private quizNo = 0;
  private examReadiness: AlexSeedResult['exam'] = { before: 0, after: 0, delta: 0, targeting: [] };

  constructor(
    private readonly dir: string,
    private readonly clock: SeedClock,
    private readonly rng: Rng,
  ) {
    this.git = new GitService(dir);
    this.learnPicker = new VariedPicker(rng);
    this.reviewPicker = new VariedPicker(rng);
    this.fillerNotePicker = new VariedPicker(rng, 6);
  }

  async run(): Promise<AlexSeedResult> {
    this.validateScreenplay();
    const events = this.buildEvents();
    const instants = this.assignInstants(events);
    for (let i = 0; i < events.length; i++) {
      await this.execute(events[i]!, instants[i]!);
    }
    // Self-checks: the spec's hard numbers, enforced at generation time so a
    // content.ts edit can't silently break the demo (the test re-asserts).
    const total = this.commits.length;
    if (total < 145 || total > 170) {
      throw new Error(`seedAlexWorkspace: ${total} commits, expected 145–170`);
    }
    const dueToday = [...this.concepts.values()].filter(
      (c) => c.srs !== null && c.srs.due === this.clock.today,
    ).length;
    if (dueToday !== 3) {
      throw new Error(`seedAlexWorkspace: ${dueToday} SRS items due today, expected exactly 3`);
    }
    this.validateSeededSessions();
    return {
      commits: this.commits,
      sessions: this.sessions,
      exam: this.examReadiness,
      today: this.clock.today,
    };
  }

  /** Guard the hand-authored session/day clubbing that drives roadmap progress. */
  private validateScreenplay(): void {
    for (const session of SESSIONS) {
      if (session.transcript.length < 5 || session.transcript.length > 9) {
        throw new Error(`seedAlexWorkspace: ${session.slug} transcript must contain 5–9 turns`);
      }
      if (session.transcript[0]?.role !== 'agent' || session.transcript.at(-1)?.role !== 'agent') {
        throw new Error(
          `seedAlexWorkspace: ${session.slug} transcript must open and close with the tutor`,
        );
      }
      for (let index = 0; index < session.transcript.length; index++) {
        const turn = session.transcript[index]!;
        if (index > 0 && turn.role === session.transcript[index - 1]!.role) {
          throw new Error(`seedAlexWorkspace: ${session.slug} transcript roles must alternate`);
        }
        if (turn.role === 'agent' && wordCount(turn.md) > 120) {
          throw new Error(`seedAlexWorkspace: ${session.slug} tutor turn exceeds 120 words`);
        }
      }
    }
    for (const roadmap of ROADMAPS) {
      for (const day of roadmap.days.filter(
        (candidate) => candidate.completedOnDay !== undefined,
      )) {
        const mapped = SESSIONS.filter(
          (session) =>
            session.mode !== 'exam' &&
            session.track === roadmap.track &&
            session.roadmapDay === day.day,
        );
        const lastSessionDay = Math.min(...mapped.map((session) => session.day));
        if (mapped.length === 0 || lastSessionDay !== day.completedOnDay) {
          throw new Error(
            `seedAlexWorkspace: ${roadmap.track} day ${day.day} completion does not match its last session`,
          );
        }
      }
    }
    const sqlDays = SESSIONS.filter(
      (session) => session.mode !== 'exam' && session.track === 'sql-interview',
    )
      .sort((a, b) => b.day - a.day)
      .map((session) => session.roadmapDay);
    if (sqlDays.some((day, index) => index > 0 && day < sqlDays[index - 1]!)) {
      throw new Error('seedAlexWorkspace: sql session roadmap days must be non-decreasing');
    }
  }

  private validateSeededSessions(): void {
    if (this.sessions.length !== SESSIONS.length) {
      throw new Error(
        `seedAlexWorkspace: ${this.sessions.length} seeded transcripts, expected ${SESSIONS.length}`,
      );
    }
    for (const seeded of this.sessions) {
      const commit = this.commits.find((candidate) => candidate.sha === seeded.commitSha);
      if (!commit) {
        throw new Error(`seedAlexWorkspace: ${seeded.session.slug} has no session commit`);
      }
      const expected = commit.deltas.map((delta) => ({ topic: commit.topic, ...delta }));
      if (JSON.stringify(seeded.conceptDeltas) !== JSON.stringify(expected)) {
        throw new Error(
          `seedAlexWorkspace: ${seeded.session.slug} wrap deltas differ from its session commit`,
        );
      }
    }
  }

  // ------------------------------------------------------------ event plan

  private buildEvents(): SeedEvent[] {
    const sqlRoadmap = ROADMAPS.find((roadmap) => roadmap.track === 'sql-interview')!;
    const pythonRoadmap = ROADMAPS.find((roadmap) => roadmap.track === 'python-dsa')!;
    const events: SeedEvent[] = [
      { kind: 'init', day: 21, order: 0 },
      { kind: 'onboarding', day: 21, order: 1 },
      { kind: 'source', day: 21, order: 1.1, roadmap: sqlRoadmap },
      { kind: 'roadmap-birth', day: 21, order: 1.2, roadmap: sqlRoadmap },
      { kind: 'track-add', day: 10, order: 0.5 },
      { kind: 'roadmap-birth', day: 10, order: 0.6, roadmap: pythonRoadmap },
    ];

    // Assessment events from the concept arcs, merging same-day groups and
    // all exam-kind steps into single multi-delta commits.
    const examSteps: Array<{ concept: ConceptSeed; step: ArcStep }> = [];
    const grouped = new Map<
      string,
      { topic: string; steps: Array<{ concept: ConceptSeed; step: ArcStep }> }
    >();
    for (const topic of TOPICS) {
      for (const concept of topic.concepts) {
        for (const step of concept.arc) {
          if (step.kind === 'exam') {
            examSteps.push({ concept, step });
            continue;
          }
          const key = step.group
            ? `${step.day}:${topic.topic}:${step.group}`
            : `${step.day}:${topic.topic}:${concept.id}:solo`;
          const bucket = grouped.get(key) ?? { topic: topic.topic, steps: [] };
          bucket.steps.push({ concept, step });
          grouped.set(key, bucket);
        }
      }
    }
    for (const { topic, steps } of grouped.values()) {
      const day = steps[0]!.step.day;
      const isReview = steps.every((s) => s.step.kind === 'review');
      // Morning python block, midday reviews, evening sql learning.
      const order = topic === 'python' ? 1 : isReview ? 2 : 3;
      events.push({ kind: 'assess', day, order: order + this.rng() * 0.5, topic, steps });
    }
    if (examSteps.length > 0) {
      events.push({ kind: 'exam', day: examSteps[0]!.step.day, order: 5, steps: examSteps });
    }

    // Misconception openings land right after the same-day event that
    // touches one of their concepts (fallback: late in the day).
    for (const misc of MISCONCEPTIONS) {
      const related = events.find(
        (e) =>
          e.day === misc.openedDay &&
          ((e.kind === 'assess' && e.steps.some((s) => misc.concepts.includes(s.concept.id))) ||
            e.kind === 'exam'),
      );
      events.push({
        kind: 'misc-open',
        day: misc.openedDay,
        order: (related?.order ?? 4) + 0.05,
        misc,
      });
    }

    for (const [dayKey, count] of Object.entries(FILLER_COUNTS)) {
      const day = Number(dayKey);
      for (let i = 0; i < count; i++) {
        const topic = day <= 10 && this.rng() < 0.35 ? 'python' : 'sql';
        // Fillers are morning warm-ups, except in week one where nothing has
        // been learned yet by breakfast — those become evening recap reps.
        const order = day >= 19 ? 4.6 + i * 0.05 : 0.1 + i * 0.05;
        events.push({ kind: 'filler', day, order, topic });
      }
    }

    for (const session of SESSIONS) {
      if (session.mode === 'exam') continue; // rides the exam commit
      events.push({ kind: 'wrap', day: session.day, order: 6, session });
    }

    for (const roadmap of ROADMAPS) {
      for (const roadmapDay of roadmap.days) {
        if (roadmapDay.completedOnDay === undefined) continue;
        events.push({
          kind: 'roadmap-complete',
          day: roadmapDay.completedOnDay,
          order: 7 + roadmapDay.day / 1_000,
          roadmap,
          roadmapDay,
        });
      }
    }

    // Chronological: oldest day first, then intra-day order.
    return events.sort((a, b) => b.day - a.day || a.order - b.order);
  }

  /** Wall-clock instants: spread across the local day, jittered, monotonic. */
  private assignInstants(events: SeedEvent[]): Date[] {
    const byDay = new Map<number, number>();
    for (const e of events) byDay.set(e.day, (byDay.get(e.day) ?? 0) + 1);
    const seen = new Map<number, number>();
    const instants: Date[] = [];
    let prevMs = 0;
    for (const e of events) {
      const n = byDay.get(e.day)!;
      const idx = seen.get(e.day) ?? 0;
      seen.set(e.day, idx + 1);
      let instant: Date;
      if (e.day === 0) {
        // Seed-day commits sit shortly before "now" — a believable morning
        // warm-up that can never be future-dated regardless of run time.
        instant = new Date(this.clock.now.getTime() - (95 - idx * 40) * 60_000);
      } else {
        const hour = 7.6 + (idx * 13.2) / Math.max(n, 1) + (this.rng() - 0.5) * 0.6;
        const h = Math.min(22, Math.max(7, hour));
        instant = this.clock.at(
          e.day,
          Math.floor(h),
          Math.floor((h % 1) * 60),
          randInt(this.rng, 0, 59),
        );
      }
      // Strict monotonicity keeps git log order == chronological order.
      if (instant.getTime() <= prevMs) instant = new Date(prevMs + 61_000);
      prevMs = instant.getTime();
      instants.push(instant);
    }
    return instants;
  }

  // ------------------------------------------------------------- execution

  private async execute(event: SeedEvent, instant: Date): Promise<void> {
    switch (event.kind) {
      case 'init': {
        for (const file of WORKSPACE_TEMPLATE) {
          await this.write(file.path, file.content);
        }
        await this.git.init();
        await this.commit(WORKSPACE_INIT_COMMIT, instant);
        return;
      }
      case 'onboarding': {
        await this.writeProfile();
        await this.writeTrack(TRACKS[0]!);
        await this.writeMastery('sql', instant);
        await this.commit(
          [
            'profile: onboarding — goals, background and the sql-interview track',
            '',
            '- Backend interviews are the goal; SQL is the rustiest surface',
            '- Prefers short, hands-on sessions with a Socratic bent',
            '- sql-interview track created with 20 weighted concepts',
          ].join('\n'),
          instant,
        );
        return;
      }
      case 'source': {
        if (!event.roadmap.source) {
          throw new Error(`seedAlexWorkspace: ${event.roadmap.track} has no source material`);
        }
        await this.write(
          `tracks/${event.roadmap.track}/sources/${event.roadmap.source.filename}`,
          event.roadmap.source.text,
        );
        await this.commit(`plan(${event.roadmap.track}): capture source material`, instant);
        return;
      }
      case 'roadmap-birth': {
        await this.writeBrief(event.roadmap);
        await this.writeInitialRoadmap(event.roadmap);
        await this.commit(
          [
            `plan(${event.roadmap.track}): create roadmap — ${event.roadmap.days.length} days`,
            '',
            `- ${event.roadmap.schedule.minutesPerDay} minutes on ${event.roadmap.schedule.studyDays.join(', ')}`,
            `- First day: ${event.roadmap.days[0]!.title}`,
          ].join('\n'),
          instant,
        );
        return;
      }
      case 'roadmap-complete': {
        await this.completeRoadmapDay(event.roadmap, event.roadmapDay, instant);
        return;
      }
      case 'track-add': {
        this.profileTracks = ['sql-interview', 'python-dsa'];
        this.profileBody = PROFILE_BODY + '\n' + PROFILE_PYTHON_NOTE;
        await this.writeProfile();
        await this.writeTrack(TRACKS[1]!);
        await this.writeMastery('python', instant);
        await this.commit(
          [
            'profile: add python-dsa track',
            '',
            '- Target roles all include a DS&A screen — adding a second track',
            '- Short morning blocks so it never crowds out SQL',
          ].join('\n'),
          instant,
        );
        return;
      }
      case 'assess':
        return this.executeAssess(event.topic, event.steps, event.day, instant);
      case 'exam':
        return this.executeExam(event.steps, event.day, instant);
      case 'misc-open':
        return this.executeMiscOpen(event.misc, instant);
      case 'filler':
        return this.executeFiller(event.topic, event.day, instant);
      case 'wrap':
        return this.executeWrap(event.session, instant);
    }
  }

  private async executeAssess(
    topic: string,
    steps: Array<{ concept: ConceptSeed; step: ArcStep }>,
    day: number,
    instant: Date,
  ): Promise<void> {
    const bullets: string[] = [];
    const deltas: string[] = [];
    let touchedMisc = false;
    for (const { concept, step } of steps) {
      const { from, note } = this.applyStep(topic, concept, step, day);
      deltas.push(`${concept.id} ${from.toFixed(2)}→${step.to.toFixed(2)}`);
      bullets.push(note);
      if (step.resolves) {
        const misc = this.miscs.get(step.resolves);
        if (misc) {
          misc.status = 'resolved';
          misc.resolvedOn = this.clock.dayIso(day);
          bullets.push(`Misconception resolved: ${lowerFirst(misc.spec.title)}`);
          touchedMisc = true;
        }
      }
    }
    const kind = steps.every((s) => s.step.kind === 'review') ? 'review' : 'learn';
    // Learn commits sometimes get a colloquial prefix; reviews stay plain
    // delta headlines (the agent's own style per the plans/02 §3 example).
    const headline =
      kind === 'learn' && this.rng() < 0.35
        ? `${this.headlinePhrase()} — ${deltas.join(', ')}`
        : deltas.join(', ');

    await this.writeMastery(topic, instant);
    await this.writeQueue();
    if (touchedMisc) await this.writeMisconceptions(topic);
    await this.commit(
      `${kind}(${topic}): ${headline}\n\n${bullets.map((b) => `- ${b}`).join('\n')}`,
      instant,
    );
  }

  private async executeExam(
    steps: Array<{ concept: ConceptSeed; step: ArcStep }>,
    day: number,
    instant: Date,
  ): Promise<void> {
    const sqlTrack = TRACKS[0]!;
    const before = this.trackReadiness(sqlTrack, instant);
    // What the examiner "targeted": the 5 weakest tested concepts by pre-exam
    // effective mastery — the same shape ExamService.targetingFor computes live.
    const targeting: ExamTarget[] = steps
      .map(({ concept }) => {
        const state = this.concepts.get(`sql/${concept.id}`);
        return {
          concept: concept.id,
          name: concept.name,
          effective:
            state && state.stepIdx > 0
              ? effectiveMastery(state.mastery, state.reviewCount, state.lastAssessed, instant)
              : 0,
        };
      })
      .sort((a, b) => a.effective - b.effective)
      .slice(0, 5);
    const deltas: Array<{ id: string; from: number; to: number }> = [];
    for (const { concept, step } of steps) {
      const { from } = this.applyStep('sql', concept, step, day);
      deltas.push({ id: concept.id, from, to: step.to });
    }
    const after = this.trackReadiness(sqlTrack, instant);
    // Delta from the ROUNDED endpoints: the results view derives its pill as
    // round1(after − before) of the stored 1dp snapshot, and every surface
    // (record bullet, commit body, results pill) must show the same number.
    const before1 = round1(before);
    const after1 = round1(after);
    this.examReadiness = {
      before: before1,
      after: after1,
      delta: round1(after1 - before1),
      targeting,
    };

    // Headline showcases the concepts the demo narrative stars (the joins
    // arc), padded with the biggest remaining boosts; the rest ride in the
    // body, where deltas are prose-only per the §3 grammar.
    const showcase = ['inner-join', 'left-join', 'group-by', 'where-clause', 'aggregates'];
    const sorted = [...deltas].sort((a, b) => {
      const ai = showcase.indexOf(a.id);
      const bi = showcase.indexOf(b.id);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return b.to - b.from - (a.to - a.from);
    });
    const headDeltas = sorted.slice(0, EXAM_HEADLINE_DELTAS);
    const restDeltas = sorted.slice(EXAM_HEADLINE_DELTAS);
    const headline = `mock exam 1 — ${EXAM_SCORE} · ${headDeltas
      .map((d) => `${d.id} ${d.from.toFixed(2)}→${d.to.toFixed(2)}`)
      .join(', ')}`;
    const bullets = [
      `Scored ${EXAM_SCORE}: joins and grouping strongest, set ops weakest`,
      `Also assessed: ${restDeltas.map((d) => `${d.id} ${d.from.toFixed(2)}→${d.to.toFixed(2)}`).join(', ')}`,
      `Readiness (sql-interview): ${this.examReadiness.before.toFixed(1)} → ${this.examReadiness.after.toFixed(1)} (+${this.examReadiness.delta.toFixed(1)})`,
      'New misconception spotted on the set-ops question (logged separately)',
    ];

    await this.writeMastery('sql', instant);
    await this.writeQueue();
    await this.writeExamRecord(day, deltas);
    const commit = await this.commit(
      `exam(sql): ${headline}\n\n${bullets.map((b) => `- ${b}`).join('\n')}`,
      instant,
    );
    const session = SESSIONS.find((candidate) => candidate.mode === 'exam');
    if (session) this.recordSession(session, instant, commit);
  }

  private async executeMiscOpen(misc: MisconceptionSeed, instant: Date): Promise<void> {
    const evidence = this.fillSlots(misc.evidence);
    this.miscs.set(misc.id, {
      spec: misc,
      status: 'open',
      firstSeen: this.clock.dayIso(misc.openedDay),
      evidence,
    });
    await this.writeMisconceptions(misc.topic);
    await this.commit(
      [
        `misconception(${misc.topic}): ${lowerFirst(misc.title)}`,
        '',
        `- ${evidence}`,
        `- Remediation: ${lowerFirst(misc.remediation)}`,
      ].join('\n'),
      instant,
    );
  }

  private async executeFiller(topic: string, day: number, instant: Date): Promise<void> {
    // Never pick the due-today (fading) concepts: a "warm-up rep on
    // window-functions" the same morning the dashboard calls it about-to-be-
    // forgotten would contradict the demo's decay story.
    const eligible = (c: ConceptState): boolean => c.stepIdx > 0 && c.spec.srsDueInDays !== 0;
    let pool = [...this.concepts.values()].filter((c) => c.topic === topic && eligible(c));
    if (pool.length === 0) {
      topic = 'sql';
      pool = [...this.concepts.values()].filter((c) => c.topic === 'sql' && eligible(c));
    }
    if (pool.length === 0) {
      throw new Error(`seedAlexWorkspace: filler on day ${day} has no learned concepts yet`);
    }
    const concept = pick(this.rng, pool);
    const note = this.fillerNotePicker
      .pick(FILLER_NOTES)
      .replaceAll('{concept}', concept.spec.name);
    this.appendNote(topic, `${this.clock.dayIso(day)}: ${note}`);
    await this.writeNotes(topic);
    const headline = pick(this.rng, FILLER_HEADLINES).replaceAll('{id}', concept.spec.id);
    await this.commit(`review(${topic}): ${headline}\n\n- ${note}`, instant);
  }

  private async executeWrap(session: SessionSeed, instant: Date): Promise<void> {
    await this.writeSession(session);
    const type = session.mode === 'review' ? 'review' : 'learn';
    const headline = pick(this.rng, SESSION_WRAP_HEADLINES).replace('{slug}', session.slug);
    const scope =
      session.topics.length > 1
        ? `across ${session.topics.join(' + ')}`
        : `on ${session.topics[0]}`;
    const bullets = [
      `${session.duration} sitting ${scope}`,
      ...(session.nextTime ? [`Next: ${session.nextTime}`] : []),
    ];
    const commit = await this.commit(
      `${type}(${session.topics[0]}): ${headline}\n\n${bullets.map((b) => `- ${b}`).join('\n')}`,
      instant,
    );
    this.recordSession(session, instant, commit);
  }

  private recordSession(session: SessionSeed, endedAt: Date, commit: SeededCommit): void {
    const durationMs = parseDurationMinutes(session.duration) * 60_000;
    const summaryMd = [...session.transcript].reverse().find((turn) => turn.role === 'agent')!.md;
    this.sessions.push({
      session,
      startedAt: new Date(endedAt.getTime() - durationMs),
      endedAt,
      commitSha: commit.sha,
      summaryMd,
      conceptDeltas: commit.deltas.map((delta) => ({ topic: commit.topic, ...delta })),
    });
  }

  // ------------------------------------------------------- state mutation

  /** Applies one arc step; returns the previous mastery and the evidence note. */
  private applyStep(
    topic: string,
    concept: ConceptSeed,
    step: ArcStep,
    day: number,
  ): { from: number; note: string } {
    const key = `${topic}/${concept.id}`;
    let state = this.concepts.get(key);
    if (!state) {
      state = {
        spec: concept,
        topic,
        mastery: 0,
        lastAssessed: this.clock.dayIso(day),
        reviewCount: 0,
        evidence: [],
        srs: null,
        stepIdx: 0,
      };
      this.concepts.set(key, state);
    }
    const from = state.mastery;
    const date = this.clock.dayIso(day);
    const note = step.note ?? this.noteFor(concept, step, state.stepIdx);
    state.mastery = step.to;
    state.lastAssessed = date;
    if (step.kind === 'review' || step.kind === 'exam') state.reviewCount += 1;
    state.evidence.push({ date, note });
    if (state.evidence.length > MAX_EVIDENCE) state.evidence.shift();
    state.stepIdx += 1;

    const isLast = state.stepIdx === concept.arc.length;
    const ease = concept.srsEase ?? 2.5;
    if (isLast && concept.srsDueInDays !== undefined) {
      state.srs = {
        interval: day + concept.srsDueInDays,
        ease,
        lapses: concept.srsLapses ?? 0,
        due: addDays(this.clock.today, concept.srsDueInDays),
      };
    } else {
      const seq = [1, 3, 7, 14, 21, 30];
      const interval = seq[Math.min(state.stepIdx - 1, seq.length - 1)]!;
      state.srs = { interval, ease, lapses: 0, due: addDays(date, interval) };
    }
    return { from, note };
  }

  private noteFor(concept: ConceptSeed, step: ArcStep, stepIdx: number): string {
    if (step.kind === 'exam') {
      return this.reviewPicker.pick(EXAM_EVIDENCE_BULLETS);
    }
    if (stepIdx < concept.flavor.length && this.rng() < 0.75) {
      return concept.flavor[stepIdx]!;
    }
    const bank = step.kind === 'review' ? GENERIC_REVIEW_BULLETS : GENERIC_LEARN_BULLETS;
    const picker = step.kind === 'review' ? this.reviewPicker : this.learnPicker;
    return this.fillSlots(picker.pick(bank));
  }

  /** Fills {ex}/{q}/… slots, advancing the id counters only when used. */
  private fillSlots(text: string): string {
    if (text.includes('{ex}')) {
      text = text.replace('{ex}', `ex-${String(++this.exerciseNo).padStart(3, '0')}`);
    }
    if (text.includes('{q}')) {
      text = text.replace('{q}', `q-${String(++this.quizNo).padStart(3, '0')}`);
    }
    return text
      .replace('{score}', `${randInt(this.rng, 3, 4)}/5`)
      .replace('{n}', String(randInt(this.rng, 4, 6)))
      .replace('{days}', String(randInt(this.rng, 4, 14)));
  }

  /** Colloquial learn-headline prefixes (the delta already names the concept). */
  private headlinePhrase(): string {
    return pick(this.rng, [
      'focused drill',
      'second pass',
      'building on last time',
      'clicked today',
      'steady progress',
      'good evening block',
    ]);
  }

  private trackReadiness(track: TrackSeed, at: Date): number {
    const items = track.items.map((item) => {
      const state = this.concepts.get(`${item.topic}/${item.concept}`);
      return {
        weight: item.weight,
        effective:
          state && state.stepIdx > 0
            ? effectiveMastery(state.mastery, state.reviewCount, state.lastAssessed, at)
            : 0,
      };
    });
    return readinessScore(items);
  }

  // ----------------------------------------------------------- file writers

  private async write(rel: string, content: string): Promise<void> {
    const abs = path.join(this.dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  private async writeBrief(seed: RoadmapSeed): Promise<void> {
    await this.write(
      `tracks/${seed.track}/brief.md`,
      [
        '---',
        `track: ${seed.track}`,
        `goal_type: ${seed.brief.goalType}`,
        ...(seed.brief.targetDate ? [`target_date: ${seed.brief.targetDate}`] : []),
        `source: ${seed.brief.source}`,
        '---',
        '',
        seed.brief.body.trim(),
        '',
      ].join('\n'),
    );
  }

  private async writeInitialRoadmap(seed: RoadmapSeed): Promise<void> {
    const roadmap = roadmapFileSchema.parse({
      track: seed.track,
      created: this.clock.dayIso(seed.createdDay),
      schedule: {
        study_days: seed.schedule.studyDays,
        minutes_per_day: seed.schedule.minutesPerDay,
        start_date: this.clock.dayIso(seed.schedule.startDay),
      },
      days: seed.days.map((day) => ({
        day: day.day,
        title: day.title,
        status: 'upcoming' as const,
        topics: day.topics,
        subtopics: day.subtopics,
      })),
    });
    await this.writeRoadmap(roadmap);
  }

  private async completeRoadmapDay(
    seed: RoadmapSeed,
    spec: RoadmapDaySeed,
    instant: Date,
  ): Promise<void> {
    const roadmap = this.roadmaps.get(seed.track);
    if (!roadmap) {
      throw new Error(`seedAlexWorkspace: ${seed.track} roadmap completed before it was created`);
    }
    const day = roadmap.days.find((candidate) => candidate.day === spec.day);
    if (!day || day.status !== 'upcoming' || spec.completedOnDay === undefined) {
      throw new Error(`seedAlexWorkspace: invalid completion for ${seed.track} day ${spec.day}`);
    }
    day.status = 'complete';
    day.completed_on = this.clock.dayIso(spec.completedOnDay);
    const reflowed = roadmap.days.filter((candidate) => candidate.status === 'upcoming').length;
    await this.writeRoadmap(roadmap);
    await this.commit(
      [
        `plan(${seed.track}): day ${spec.day} complete — ${spec.title}`,
        '',
        `- Covered: ${spec.subtopics.join('; ')}`,
        ...(reflowed > 0 ? [`- Reflowed ${reflowed} days from ${day.completed_on}`] : []),
      ].join('\n'),
      instant,
    );
  }

  /** Keep byte-for-byte parity with TrackService.completeDay serialization. */
  private async writeRoadmap(roadmap: RoadmapFile): Promise<void> {
    const valid = roadmapFileSchema.parse(roadmap);
    this.roadmaps.set(valid.track, valid);
    await this.write(
      `tracks/${valid.track}/roadmap.yaml`,
      yamlDump(valid, { noRefs: true, lineWidth: -1 }),
    );
  }

  private async writeProfile(): Promise<void> {
    await this.write(
      'profile.md',
      [
        '---',
        'name: Alex',
        'goal: Pass backend engineer interviews by September 2026',
        `tracks: [${this.profileTracks.join(', ')}]`,
        'preferences:',
        '  session_length: short',
        '  style: socratic',
        '  humor: light',
        `timezone: ${ALEX_TIMEZONE}`,
        '---',
        '',
        this.profileBody,
        '',
      ].join('\n'),
    );
  }

  private async writeTrack(track: TrackSeed): Promise<void> {
    const targetDate =
      track.targetDate ??
      (track.targetInDays === undefined
        ? undefined
        : addDays(this.clock.today, track.targetInDays));
    if (targetDate === undefined) {
      throw new Error(`seedAlexWorkspace: ${track.track} has no target date`);
    }
    const lines = [
      `track: ${track.track}`,
      `display_name: ${track.displayName}`,
      `target_date: ${targetDate}`,
      'items:',
    ];
    for (const item of track.items) {
      lines.push(
        `  - concept: ${item.concept}`,
        `    topic: ${item.topic}`,
        `    weight: ${item.weight}`,
      );
    }
    await this.write(`tracks/${track.track}/track.yaml`, lines.join('\n') + '\n');
  }

  private async writeMastery(topic: string, instant: Date): Promise<void> {
    const seed = TOPICS.find((t) => t.topic === topic)!;
    const states = [...this.concepts.values()].filter((c) => c.topic === topic);
    // File order follows the curriculum (stable across commits — clean diffs).
    const ordered = seed.concepts
      .map((c) => states.find((s) => s.spec.id === c.id))
      .filter((s): s is ConceptState => s !== undefined);
    const lines = [
      `topic: ${topic}`,
      `display_name: ${seed.displayName}`,
      `updated: ${instant.toISOString()}`,
      ordered.length === 0 ? 'concepts: []' : 'concepts:',
    ];
    for (const s of ordered) {
      const confidence =
        s.mastery >= 0.7 && s.reviewCount >= 2 ? 'high' : s.mastery >= 0.45 ? 'medium' : 'low';
      lines.push(
        `  - id: ${s.spec.id}`,
        `    name: ${JSON.stringify(s.spec.name)}`,
        `    mastery: ${s.mastery.toFixed(2)}`,
        `    confidence: ${confidence}`,
        `    last_assessed: ${s.lastAssessed}`,
        `    review_count: ${s.reviewCount}`,
        `    prereqs: [${s.spec.prereqs.join(', ')}]`,
        '    evidence:',
      );
      for (const ev of [...s.evidence].reverse()) {
        lines.push(`      - date: ${ev.date}`, `        note: ${JSON.stringify(ev.note)}`);
      }
    }
    await this.write(`topics/${topic}/mastery.yaml`, lines.join('\n') + '\n');
  }

  private async writeQueue(): Promise<void> {
    const items = [...this.concepts.values()]
      .filter((c) => c.srs !== null)
      .sort((a, b) => a.srs!.due.localeCompare(b.srs!.due) || a.spec.id.localeCompare(b.spec.id));
    const lines = items.length === 0 ? ['items: []'] : ['items:'];
    for (const c of items) {
      const srs = c.srs!;
      lines.push(
        `  - concept: ${c.spec.id}`,
        `    topic: ${c.topic}`,
        `    due: ${srs.due}`,
        `    interval_days: ${srs.interval}`,
        `    ease: ${srs.ease}`,
        `    lapses: ${srs.lapses}`,
      );
    }
    await this.write('srs/queue.yaml', lines.join('\n') + '\n');
  }

  private async writeMisconceptions(topic: string): Promise<void> {
    const entries = [...this.miscs.values()].filter((m) => m.spec.topic === topic);
    const open = entries.filter((m) => m.status === 'open');
    const resolved = entries.filter((m) => m.status === 'resolved');
    const block = (m: MiscState): string[] => [
      m.status === 'open'
        ? `## [OPEN] ${m.spec.title}`
        : `## [RESOLVED ${m.resolvedOn}] ${m.spec.title}`,
      `- first_seen: ${m.firstSeen} · concepts: [${m.spec.concepts.join(', ')}]`,
      `- Evidence: ${m.evidence}`,
      `- Remediation: ${m.spec.remediation}`,
      '',
    ];
    const lines = [
      ...open.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen)).flatMap(block),
      ...resolved
        .sort((a, b) => (b.resolvedOn ?? '').localeCompare(a.resolvedOn ?? ''))
        .flatMap(block),
    ];
    await this.write(`topics/${topic}/misconceptions.md`, lines.join('\n').trimEnd() + '\n');
  }

  private appendNote(topic: string, line: string): void {
    const lines = this.notes.get(topic) ?? [];
    lines.push(line);
    this.notes.set(topic, lines);
  }

  private async writeNotes(topic: string): Promise<void> {
    const lines = this.notes.get(topic) ?? [];
    await this.write(
      `topics/${topic}/notes.md`,
      `# Tutor notes — ${topic}\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`,
    );
  }

  private async writeSession(session: SessionSeed): Promise<void> {
    const date = this.clock.dayIso(session.day);
    const narrative = session.narrative.replace(
      '{examDelta}',
      `+${this.examReadiness.delta.toFixed(1)}`,
    );
    await this.write(
      `sessions/${date}-${session.slug}.md`,
      [
        '---',
        `date: ${date}`,
        `mode: ${session.mode}`,
        `track: ${session.track}`,
        `roadmap_day: ${session.roadmapDay}`,
        `title: ${JSON.stringify(session.title)}`,
        `topics: [${session.topics.join(', ')}]`,
        `duration_estimate: ${session.duration}`,
        `concepts_touched: [${session.concepts.join(', ')}]`,
        // Quoted: pointers may contain YAML-significant characters (colons).
        ...(session.nextTime ? [`next_time: ${JSON.stringify(session.nextTime)}`] : []),
        '---',
        '',
        narrative,
        '',
      ].join('\n'),
    );
  }

  private async writeExamRecord(
    day: number,
    deltas: Array<{ id: string; from: number; to: number }>,
  ): Promise<void> {
    const date = this.clock.dayIso(day);
    const { before, after, delta } = this.examReadiness;
    // The question table is the seeded Exam DB row's content (exam-row.ts) —
    // one source, so the record and the History results view cannot diverge.
    const questions = ALEX_EXAM_QUESTIONS.map((q) => ({
      id: q.id,
      kind: q.kind,
      concept: q.concept,
      gist: q.gist,
      verdict: q.verdict,
      pts: `${q.pointsAwarded}/${q.points}`,
      note: q.note,
    }));
    const lines = [
      '---',
      `date: ${date}`,
      'track: sql-interview',
      'score: 71',
      '---',
      '',
      '# Mock exam 1 — SQL Interview Prep',
      '',
      `Timed 60m mock generated from the weakest tracked concepts. Score: **${EXAM_SCORE}**.`,
      '',
      '## Questions',
      '',
      ...questions.map(
        (q) =>
          `- **${q.id}** (${q.kind}, ${q.concept}) — ${q.gist} → ${q.verdict}, ${q.pts}` +
          (q.note ? ` _(${q.note})_` : ''),
      ),
      '',
      '## Mastery updates',
      '',
      ...deltas.map((d) => `- ${d.id}: ${d.from.toFixed(2)} → ${d.to.toFixed(2)}`),
      '',
      '## Readiness',
      '',
      `- Before: ${before.toFixed(1)} / 100`,
      `- After: ${after.toFixed(1)} / 100`,
      `- Delta: +${delta.toFixed(1)}`,
      '',
    ];
    await this.write(`exams/${date}-sql-interview-mock.md`, lines.join('\n'));
  }

  // ---------------------------------------------------------------- commit

  private async commit(message: string, instant: Date): Promise<SeededCommit> {
    const parsed = parseCommit(message);
    if (parsed === null) {
      throw new Error(`seedAlexWorkspace produced an off-grammar commit:\n${message}`);
    }
    const sha = await this.git.commitAll(message, { backdate: instant });
    const commit = {
      sha,
      instant,
      type: parsed.type,
      topic: parsed.topic ?? 'general',
      headline: parsed.headline,
      bullets: parsed.bullets,
      deltas: parsed.deltas,
    };
    this.commits.push(commit);
    return commit;
  }
}

const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);
const round1 = (n: number): number => Math.round(n * 10) / 10;
const wordCount = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;

function parseDurationMinutes(duration: string): number {
  const match = /^(\d+)m$/.exec(duration);
  if (!match) throw new Error(`seedAlexWorkspace: unsupported session duration ${duration}`);
  return Number(match[1]);
}
