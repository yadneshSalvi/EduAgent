/**
 * The demo learner's screenplay (plans/02 §7, plans/07 §1): every concept's
 * mastery arc over ~21 days, the misconception log, session sittings, and the
 * phrase banks the generator draws bullets from.
 *
 * Numbers here are CALIBRATED against the shared learning-math so the seeded
 * dashboard lands where the demo needs it (sql-interview readiness ~64 with a
 * +9 exam jump two days back, python-dsa ~40, exactly window-functions +
 * indexes-basics fading). If you change a mastery/review_count/day literal,
 * re-run apps/server/test/seed-demo.test.ts — it asserts all of those bands.
 *
 * Day numbers are "days ago" relative to the seed instant (0 = seed day).
 * Rest days (no commits at all): 17 and 13 — the day-13 gap is what makes the
 * streak read ~13 rather than "three perfect weeks" (nobody's that perfect).
 */

export type ArcKind = 'learn' | 'review' | 'exam';

export interface ArcStep {
  day: number;
  /** Mastery after this assessment (2dp; the commit headline shows from→to). */
  to: number;
  kind: ArcKind;
  /** Evidence note override; otherwise drawn from flavor/generic banks. */
  note?: string;
  /** Misconception id (see MISCONCEPTIONS) resolved in this commit. */
  resolves?: string;
  /** Steps on the same day sharing a group land in ONE commit (multi-delta). */
  group?: string;
}

export interface ConceptSeed {
  id: string;
  name: string;
  prereqs: string[];
  /** Concept-specific evidence/bullet lines, used before generic banks. */
  flavor: string[];
  arc: ArcStep[];
  /** Final SRS due date = today + N days (omit → concept not in the queue). */
  srsDueInDays?: number;
  srsEase?: number;
  srsLapses?: number;
}

export interface TopicSeed {
  topic: string;
  displayName: string;
  concepts: ConceptSeed[];
}

export interface TrackSeed {
  track: string;
  displayName: string;
  /** target_date = today + N days (keeps reseeds believable at any date). */
  targetInDays?: number;
  /** Fixed deadline when the demo story names a real date. */
  targetDate?: string;
  items: Array<{ concept: string; topic: string; weight: number }>;
}

export type StudyDaySeed = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface RoadmapDaySeed {
  day: number;
  title: string;
  /** Seed day on which the final mapped session completes this roadmap day. */
  completedOnDay?: number;
  topics: Array<{ topic: string; concepts: string[] }>;
  subtopics: string[];
}

export interface RoadmapSeed {
  track: string;
  createdDay: number;
  schedule: {
    studyDays: StudyDaySeed[];
    minutesPerDay: number;
    startDay: number;
  };
  brief: {
    goalType: 'interview' | 'exam' | 'mastery' | 'explore';
    targetDate?: string;
    source: 'job-description' | 'syllabus' | 'self-described' | 'none';
    body: string;
  };
  source?: { filename: string; text: string };
  days: RoadmapDaySeed[];
}

export interface MisconceptionSeed {
  id: string;
  topic: string;
  title: string;
  concepts: string[];
  openedDay: number;
  resolvedDay?: number;
  /** May contain {q}/{ex} placeholders filled with live quiz/exercise ids. */
  evidence: string;
  remediation: string;
}

export interface SessionSeed {
  day: number;
  slug: string;
  mode: 'learn' | 'review' | 'exam';
  /** Deliberately hand-authored grouping metadata for the track session rail. */
  track: string;
  roadmapDay: number;
  title: string;
  topics: string[];
  duration: string;
  concepts: string[];
  nextTime?: string;
  narrative: string;
}

// ---------------------------------------------------------------------------
// SQL topic
// ---------------------------------------------------------------------------

const SQL_CONCEPTS: ConceptSeed[] = [
  {
    id: 'select-basics',
    name: 'SELECT basics',
    prereqs: [],
    flavor: [
      'Projections, aliases and DISTINCT all landed on the first pass',
      'Column aliases in ORDER BY tripped once, then stuck',
      'Rebuilt the demo query from memory without looking at notes',
    ],
    arc: [
      { day: 20, to: 0.55, kind: 'learn' },
      { day: 19, to: 0.74, kind: 'learn' },
      { day: 16, to: 0.8, kind: 'review' },
      { day: 11, to: 0.84, kind: 'review' },
      { day: 6, to: 0.91, kind: 'review' },
      { day: 2, to: 0.93, kind: 'exam' },
    ],
    srsDueInDays: 12,
    srsEase: 2.7,
  },
  {
    id: 'where-clause',
    name: 'WHERE clause',
    prereqs: ['select-basics'],
    flavor: [
      'Comparison and BETWEEN predicates solid; NULL comparisons shaky',
      'IN-list vs OR chains — picked the right one under time pressure',
      'Wrote a three-condition filter without parenthesis mistakes',
    ],
    arc: [
      { day: 19, to: 0.48, kind: 'learn' },
      { day: 18, to: 0.62, kind: 'learn' },
      { day: 14, to: 0.7, kind: 'review', resolves: 'null-where', group: 'null-review' },
      { day: 8, to: 0.81, kind: 'review' },
      { day: 2, to: 0.86, kind: 'exam' },
    ],
    srsDueInDays: 9,
    srsEase: 2.6,
  },
  {
    id: 'order-by-limit',
    name: 'ORDER BY & LIMIT',
    prereqs: ['select-basics'],
    flavor: [
      'Multi-key sorts with mixed ASC/DESC read cleanly now',
      'Top-N-per-day phrasing still takes a second to set up',
    ],
    arc: [
      { day: 18, to: 0.6, kind: 'learn' },
      { day: 15, to: 0.72, kind: 'review' },
      { day: 10, to: 0.82, kind: 'review' },
      { day: 5, to: 0.9, kind: 'review' },
    ],
    srsDueInDays: 8,
    srsEase: 2.65,
  },
  {
    id: 'distinct-dedup',
    name: 'DISTINCT & dedup',
    prereqs: ['select-basics'],
    flavor: [
      'DISTINCT vs GROUP BY dedup — explained when each applies',
      'Caught a silent duplicate-row bug in the practice dataset',
    ],
    arc: [
      { day: 18, to: 0.55, kind: 'learn' },
      { day: 14, to: 0.66, kind: 'review' },
      { day: 9, to: 0.75, kind: 'review' },
      { day: 5, to: 0.84, kind: 'review' },
    ],
    srsDueInDays: 10,
    srsEase: 2.6,
  },
  {
    id: 'inner-join',
    name: 'INNER JOIN',
    prereqs: ['select-basics', 'where-clause'],
    flavor: [
      'Rows multiplying on duplicate keys — drew the match table by hand to see why',
      'Two-table joins now written without consulting the syntax notes',
      'Join-then-filter versus filter-then-join order finally makes sense',
      'Composite join keys handled correctly on the orders/customers pair',
    ],
    arc: [
      { day: 16, to: 0.2, kind: 'learn', note: 'First attempt: rows multiplied unexpectedly on duplicate keys' },
      { day: 15, to: 0.35, kind: 'learn' },
      { day: 14, to: 0.48, kind: 'learn' },
      { day: 11, to: 0.56, kind: 'review' },
      { day: 8, to: 0.64, kind: 'learn' },
      { day: 6, to: 0.72, kind: 'learn' },
      { day: 4, to: 0.79, kind: 'review' },
      { day: 2, to: 0.83, kind: 'exam' },
    ],
    srsDueInDays: 6,
    srsEase: 2.5,
    srsLapses: 1,
  },
  {
    id: 'left-join',
    name: 'LEFT JOIN',
    prereqs: ['inner-join'],
    flavor: [
      'NULL-extended rows still surprise in aggregate queries',
      'Kept unmatched customers correctly on the retention query',
      'LEFT vs INNER choice articulated correctly for three scenarios',
    ],
    arc: [
      { day: 6, to: 0.25, kind: 'learn', note: 'First pass: which side keeps its rows took two tries' },
      { day: 4, to: 0.42, kind: 'learn' },
      { day: 2, to: 0.48, kind: 'exam' },
      {
        day: 1,
        to: 0.62,
        kind: 'learn',
        note: 'COUNT over NULL-extended rows corrected after one miss; NULL-key matching still trips',
      },
    ],
    srsDueInDays: 3,
    srsEase: 2.4,
  },
  {
    id: 'joins-multi-table',
    name: 'Multi-table joins',
    prereqs: ['inner-join', 'left-join'],
    flavor: [
      'Three-table chain built incrementally, checking row counts at each step',
      'Bridge-table joins for many-to-many read fluently now',
    ],
    arc: [
      { day: 10, to: 0.35, kind: 'learn' },
      { day: 7, to: 0.52, kind: 'learn' },
      { day: 5, to: 0.64, kind: 'review' },
      { day: 2, to: 0.69, kind: 'exam' },
    ],
    srsDueInDays: 5,
    srsEase: 2.45,
  },
  {
    id: 'group-by',
    name: 'GROUP BY',
    prereqs: ['select-basics', 'aggregates'],
    flavor: [
      'Grouping grain stated out loud before writing each query — it helps',
      'Group-by-then-join versus join-then-group tradeoff explained correctly',
    ],
    arc: [
      { day: 15, to: 0.45, kind: 'learn' },
      { day: 14, to: 0.58, kind: 'learn' },
      { day: 12, to: 0.68, kind: 'review', resolves: 'groupby-cols' },
      { day: 7, to: 0.79, kind: 'review' },
      { day: 2, to: 0.85, kind: 'exam' },
    ],
    srsDueInDays: 7,
    srsEase: 2.6,
  },
  {
    id: 'aggregates',
    name: 'Aggregate functions',
    prereqs: ['select-basics'],
    flavor: [
      'COUNT(*) vs COUNT(col) NULL behavior — got it right twice unprompted',
      'AVG over sparse data: remembered the NULL-skipping rule',
    ],
    arc: [
      { day: 15, to: 0.5, kind: 'learn' },
      { day: 12, to: 0.62, kind: 'learn' },
      { day: 9, to: 0.74, kind: 'review' },
      { day: 5, to: 0.83, kind: 'review' },
      { day: 2, to: 0.87, kind: 'exam' },
    ],
    srsDueInDays: 11,
    srsEase: 2.65,
  },
  {
    id: 'having',
    name: 'HAVING',
    prereqs: ['group-by'],
    flavor: [
      'WHERE-vs-HAVING placement chosen correctly on 3/3 drill queries',
      'Filtered aggregates without reaching for a subquery this time',
    ],
    arc: [
      { day: 12, to: 0.42, kind: 'learn' },
      { day: 9, to: 0.56, kind: 'learn' },
      { day: 7, to: 0.64, kind: 'review' },
      { day: 4, to: 0.74, kind: 'review' },
    ],
    srsDueInDays: 0, // one of the 3 reviews due today
    srsEase: 2.5,
  },
  {
    id: 'subqueries',
    name: 'Subqueries',
    prereqs: ['select-basics', 'where-clause'],
    flavor: [
      'Correlated vs uncorrelated distinction explained with own example',
      'Scalar subquery in SELECT list used appropriately (and sparingly)',
    ],
    arc: [
      { day: 9, to: 0.38, kind: 'learn' },
      { day: 7, to: 0.54, kind: 'learn' },
      { day: 4, to: 0.66, kind: 'review' },
      { day: 2, to: 0.72, kind: 'exam' },
    ],
    srsDueInDays: 5,
    srsEase: 2.5,
  },
  {
    id: 'cte',
    name: 'CTEs (WITH)',
    prereqs: ['subqueries'],
    flavor: [
      'Rewrote a nested subquery as a two-step CTE — much more readable',
      'CTE column naming and reuse across steps handled cleanly',
    ],
    arc: [
      { day: 6, to: 0.4, kind: 'learn' },
      { day: 4, to: 0.54, kind: 'learn' },
      { day: 2, to: 0.62, kind: 'exam' },
    ],
    srsDueInDays: 4,
    srsEase: 2.4,
  },
  {
    id: 'window-functions',
    name: 'Window functions',
    prereqs: ['group-by', 'order-by-limit'],
    flavor: [
      'ROW_NUMBER vs RANK vs DENSE_RANK differences recited correctly',
      'OVER (PARTITION BY …) syntax still needs the docs open',
      'Running totals with SUM() OVER built after one hint',
    ],
    // All learns, no successful review (review_count 0 → 7-day half-life):
    // ten untouched days later this is the loudest fading concept on the
    // dashboard, which is exactly the demo's decay story.
    arc: [
      { day: 12, to: 0.3, kind: 'learn' },
      { day: 11, to: 0.45, kind: 'learn' },
      { day: 10, to: 0.55, kind: 'learn' },
    ],
    srsDueInDays: 0, // due today AND visibly fading — the review-story setup
    srsEase: 2.3,
    srsLapses: 1,
  },
  {
    id: 'indexes-basics',
    name: 'Indexes',
    prereqs: ['where-clause'],
    flavor: [
      'B-tree intuition sketched; composite index column order still fuzzy',
      'Read a query plan and spotted the full table scan',
    ],
    arc: [
      { day: 9, to: 0.32, kind: 'learn' },
      { day: 8, to: 0.5, kind: 'learn', resolves: 'pk-order' },
    ],
    srsDueInDays: 0, // due today AND visibly fading
    srsEase: 2.3,
  },
  {
    id: 'exists-in-vs-join',
    name: 'EXISTS / IN vs JOIN',
    prereqs: ['subqueries', 'inner-join'],
    flavor: [
      'Chose EXISTS over IN for the NULL-safe membership check',
      'Anti-join with NOT EXISTS written correctly first try',
    ],
    arc: [
      { day: 5, to: 0.42, kind: 'learn' },
      { day: 3, to: 0.55, kind: 'learn' },
      { day: 2, to: 0.59, kind: 'exam' },
    ],
    srsDueInDays: 6,
    srsEase: 2.4,
  },
  {
    id: 'null-semantics',
    name: 'NULL semantics',
    prereqs: ['where-clause'],
    flavor: [
      'Three-valued logic table reproduced from memory',
      'IS NULL vs = NULL distinction now automatic in WHERE clauses',
      'COALESCE defaults applied in the right places on the report query',
    ],
    arc: [
      { day: 18, to: 0.4, kind: 'learn' },
      { day: 14, to: 0.57, kind: 'review', group: 'null-review' },
      { day: 3, to: 0.72, kind: 'learn' },
      { day: 2, to: 0.78, kind: 'exam' },
    ],
    srsDueInDays: 8,
    srsEase: 2.55,
  },
  {
    id: 'case-expressions',
    name: 'CASE expressions',
    prereqs: ['select-basics'],
    flavor: [
      'Searched CASE with fall-through ELSE handled correctly',
      'Pivoted a status column into buckets without looking anything up',
    ],
    arc: [
      { day: 11, to: 0.45, kind: 'learn' },
      { day: 8, to: 0.58, kind: 'review' },
      { day: 3, to: 0.75, kind: 'review' },
    ],
    srsDueInDays: 9,
    srsEase: 2.5,
  },
  {
    id: 'union-set-ops',
    name: 'UNION & set ops',
    prereqs: ['select-basics'],
    flavor: [
      'UNION vs UNION ALL semantics — still reaching for the wrong default',
      'INTERSECT used correctly to find the overlap set',
    ],
    arc: [
      { day: 7, to: 0.35, kind: 'learn' },
      { day: 3, to: 0.48, kind: 'learn' },
      { day: 2, to: 0.52, kind: 'exam' },
    ],
    srsDueInDays: 2,
    srsEase: 2.35,
    srsLapses: 1,
  },
  {
    id: 'self-joins',
    name: 'Self joins',
    prereqs: ['inner-join'],
    flavor: [
      'Employee/manager hierarchy query aliased both sides correctly',
      'Still slow to spot when a self join is the right tool',
    ],
    arc: [
      { day: 4, to: 0.34, kind: 'learn' },
      { day: 2, to: 0.44, kind: 'exam' },
    ],
    srsDueInDays: 4,
    srsEase: 2.3,
  },
  {
    id: 'string-functions',
    name: 'String functions',
    prereqs: ['select-basics'],
    flavor: [
      'SUBSTR/INSTR combo for domain extraction written from memory',
      'Concatenation NULL-propagation caught before it bit',
    ],
    arc: [
      { day: 14, to: 0.4, kind: 'learn' },
      { day: 10, to: 0.52, kind: 'review' },
      { day: 4, to: 0.6, kind: 'review' },
    ],
    srsDueInDays: 13,
    srsEase: 2.5,
  },
  {
    id: 'date-functions',
    name: 'Date & time functions',
    prereqs: ['select-basics'],
    flavor: [
      'Month bucketing with strftime handled on the first try',
      'Date arithmetic across month boundaries still needs care',
    ],
    arc: [
      { day: 10, to: 0.38, kind: 'learn' },
      { day: 6, to: 0.48, kind: 'review' },
      { day: 3, to: 0.56, kind: 'review' },
    ],
    srsDueInDays: 7,
    srsEase: 2.45,
  },
];

// ---------------------------------------------------------------------------
// Python topic (track starts on day 10 — the secondary, early track)
// ---------------------------------------------------------------------------

const PYTHON_CONCEPTS: ConceptSeed[] = [
  {
    id: 'big-o',
    name: 'Big-O analysis',
    prereqs: [],
    flavor: [
      'Classified 6/7 snippets correctly; amortized cases still shaky',
      'Nested-loop vs sorted-then-scan tradeoff argued correctly',
      'Log factors spotted in both binary search and heap push',
    ],
    arc: [
      { day: 10, to: 0.4, kind: 'learn' },
      { day: 8, to: 0.55, kind: 'learn' },
      { day: 6, to: 0.65, kind: 'review' },
      { day: 4, to: 0.75, kind: 'review' },
    ],
    srsDueInDays: 10,
    srsEase: 2.6,
  },
  {
    id: 'arrays-lists',
    name: 'Arrays & lists',
    prereqs: [],
    flavor: [
      'Slice semantics (copies, not views) demonstrated with an example',
      'In-place reversal written without an index error',
    ],
    arc: [
      { day: 10, to: 0.42, kind: 'learn' },
      { day: 7, to: 0.56, kind: 'review' },
      { day: 4, to: 0.66, kind: 'learn', resolves: 'append-on' },
      { day: 2, to: 0.74, kind: 'review' },
    ],
    srsDueInDays: 6,
    srsEase: 2.55,
  },
  {
    id: 'strings-py',
    name: 'String manipulation',
    prereqs: ['arrays-lists'],
    flavor: [
      'Built the char-frequency counter idiomatically with a dict',
      'Immutability + join() pattern used instead of += in the loop',
    ],
    arc: [
      { day: 9, to: 0.4, kind: 'learn' },
      { day: 6, to: 0.52, kind: 'learn' },
      { day: 2, to: 0.6, kind: 'review' },
    ],
    srsDueInDays: 5,
    srsEase: 2.5,
  },
  {
    id: 'hashmaps',
    name: 'Hash maps',
    prereqs: ['arrays-lists'],
    flavor: [
      'Two-sum with a dict written in under five minutes',
      'defaultdict vs get(k, default) chosen appropriately',
    ],
    arc: [
      { day: 8, to: 0.4, kind: 'learn' },
      { day: 5, to: 0.55, kind: 'learn' },
      { day: 2, to: 0.66, kind: 'review' },
    ],
    srsDueInDays: 4,
    srsEase: 2.55,
  },
  {
    id: 'two-pointers',
    name: 'Two pointers',
    prereqs: ['arrays-lists'],
    flavor: [
      'Pair-sum on sorted input solved with converging pointers',
      'Pointer-advance conditions reasoned out loud before coding',
    ],
    arc: [
      { day: 4, to: 0.35, kind: 'learn' },
      { day: 1, to: 0.48, kind: 'learn', group: 'py-patterns' },
    ],
    srsDueInDays: 2,
    srsEase: 2.4,
  },
  {
    id: 'sliding-window',
    name: 'Sliding window',
    prereqs: ['two-pointers'],
    flavor: [
      'Fixed-size window average done; variable-size shrink condition needed a hint',
    ],
    arc: [{ day: 1, to: 0.36, kind: 'learn', group: 'py-patterns' }],
    srsDueInDays: 1,
    srsEase: 2.35,
  },
  {
    id: 'stacks-queues',
    name: 'Stacks & queues',
    prereqs: ['arrays-lists'],
    flavor: [
      'Balanced-brackets check with a stack passed all cases',
      'deque chosen over list.pop(0) — and explained why',
    ],
    arc: [
      { day: 7, to: 0.36, kind: 'learn' },
      { day: 3, to: 0.5, kind: 'review' },
    ],
    srsDueInDays: 7,
    srsEase: 2.45,
  },
  {
    id: 'recursion',
    name: 'Recursion',
    prereqs: [],
    flavor: [
      'Base case stated before the recursive case — new habit sticking',
      'Traced the call stack for factorial and fib without notes',
    ],
    arc: [
      { day: 9, to: 0.38, kind: 'learn' },
      { day: 7, to: 0.48, kind: 'review' },
      { day: 5, to: 0.58, kind: 'review' },
    ],
    srsDueInDays: 3,
    srsEase: 2.5,
  },
  {
    id: 'binary-search',
    name: 'Binary search',
    prereqs: ['arrays-lists', 'big-o'],
    flavor: [
      'Off-by-one on the right boundary — twice — then nailed the template',
      'Search-on-answer variant recognized unprompted',
    ],
    arc: [
      { day: 6, to: 0.44, kind: 'learn' },
      { day: 2, to: 0.6, kind: 'review' },
    ],
    srsDueInDays: 5,
    srsEase: 2.45,
    srsLapses: 1,
  },
  {
    id: 'sorting',
    name: 'Sorting',
    prereqs: ['big-o'],
    flavor: [
      'sorted() with key lambdas fluent; stability property explained',
      'Merge-sort sketch written; quicksort partition still rough',
    ],
    arc: [
      { day: 8, to: 0.36, kind: 'learn' },
      { day: 3, to: 0.5, kind: 'review' },
    ],
    srsDueInDays: 8,
    srsEase: 2.4,
  },
  {
    id: 'linked-lists',
    name: 'Linked lists',
    prereqs: ['recursion'],
    flavor: [
      'Node-hopping reversal drawn out on paper before coding',
    ],
    arc: [{ day: 2, to: 0.36, kind: 'learn' }],
    srsDueInDays: 1,
    srsEase: 2.35,
  },
  {
    id: 'trees-basics',
    name: 'Binary trees',
    prereqs: ['recursion'],
    flavor: [
      'In-order traversal recursed correctly; iterative version pending',
    ],
    arc: [{ day: 1, to: 0.3, kind: 'learn' }],
    srsDueInDays: 2,
    srsEase: 2.35,
  },
  {
    id: 'list-comprehensions',
    name: 'List comprehensions',
    prereqs: ['arrays-lists'],
    flavor: [
      'Nested comprehension unrolled into loops and back',
      'Filter-then-map comprehension idiom now the default reach',
    ],
    arc: [
      { day: 10, to: 0.45, kind: 'learn' },
      { day: 8, to: 0.56, kind: 'review' },
      { day: 5, to: 0.66, kind: 'review' },
    ],
    srsDueInDays: 11,
    srsEase: 2.55,
  },
];

export const TOPICS: TopicSeed[] = [
  { topic: 'sql', displayName: 'SQL', concepts: SQL_CONCEPTS },
  { topic: 'python', displayName: 'Python', concepts: PYTHON_CONCEPTS },
];

// ---------------------------------------------------------------------------
// Tracks (query-optimization / graphs / dp / heaps are deliberately unlearned:
// they anchor the "weakest concepts" list that exam mode attacks)
// ---------------------------------------------------------------------------

export const TRACKS: TrackSeed[] = [
  {
    track: 'sql-interview',
    displayName: 'SQL Interview Prep',
    targetDate: '2026-09-02',
    items: [
      { concept: 'select-basics', topic: 'sql', weight: 1.0 },
      { concept: 'where-clause', topic: 'sql', weight: 1.0 },
      { concept: 'order-by-limit', topic: 'sql', weight: 0.8 },
      { concept: 'distinct-dedup', topic: 'sql', weight: 0.6 },
      { concept: 'inner-join', topic: 'sql', weight: 1.5 },
      { concept: 'left-join', topic: 'sql', weight: 1.5 },
      { concept: 'joins-multi-table', topic: 'sql', weight: 1.2 },
      { concept: 'group-by', topic: 'sql', weight: 1.2 },
      { concept: 'aggregates', topic: 'sql', weight: 1.0 },
      { concept: 'having', topic: 'sql', weight: 0.8 },
      { concept: 'subqueries', topic: 'sql', weight: 1.2 },
      { concept: 'cte', topic: 'sql', weight: 1.0 },
      { concept: 'window-functions', topic: 'sql', weight: 1.2 },
      { concept: 'indexes-basics', topic: 'sql', weight: 0.8 },
      { concept: 'exists-in-vs-join', topic: 'sql', weight: 0.9 },
      { concept: 'null-semantics', topic: 'sql', weight: 1.0 },
      { concept: 'case-expressions', topic: 'sql', weight: 0.6 },
      { concept: 'union-set-ops', topic: 'sql', weight: 0.6 },
      { concept: 'self-joins', topic: 'sql', weight: 0.6 },
      { concept: 'query-optimization', topic: 'sql', weight: 0.5 },
    ],
  },
  {
    track: 'python-dsa',
    displayName: 'Python DS&A',
    targetInDays: 74,
    items: [
      { concept: 'big-o', topic: 'python', weight: 1.0 },
      { concept: 'arrays-lists', topic: 'python', weight: 1.0 },
      { concept: 'strings-py', topic: 'python', weight: 0.8 },
      { concept: 'hashmaps', topic: 'python', weight: 1.2 },
      { concept: 'two-pointers', topic: 'python', weight: 1.0 },
      { concept: 'sliding-window', topic: 'python', weight: 1.0 },
      { concept: 'stacks-queues', topic: 'python', weight: 1.0 },
      { concept: 'recursion', topic: 'python', weight: 1.0 },
      { concept: 'binary-search', topic: 'python', weight: 1.0 },
      { concept: 'sorting', topic: 'python', weight: 0.8 },
      { concept: 'linked-lists', topic: 'python', weight: 0.8 },
      { concept: 'trees-basics', topic: 'python', weight: 1.0 },
      { concept: 'graphs-basics', topic: 'python', weight: 1.0 },
      { concept: 'dp-intro', topic: 'python', weight: 1.0 },
      { concept: 'heaps', topic: 'python', weight: 0.8 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Roadmaps, briefs, and source material. Completion dates are tied explicitly
// to the LAST session mapped to each day; alex.ts turns the relative seed days
// into calendar dates and serializes the resulting object with js-yaml.
// ---------------------------------------------------------------------------

export const SQL_JOB_DESCRIPTION = `# Backend Engineer — Data Services

We are hiring a backend engineer to build reliable TypeScript services and data-heavy APIs.

- Write and optimize production SQL across joins, aggregates, subqueries, and window functions.
- Explain query plans and choose practical indexes for high-volume PostgreSQL tables.
- Debug correctness issues involving NULLs, duplicate rows, and reporting grain.
- Communicate trade-offs clearly during design reviews and pair-programming sessions.

The interview includes a 60-minute SQL exercise plus a discussion of schema and query design.
`;

export const ROADMAPS: RoadmapSeed[] = [
  {
    track: 'sql-interview',
    createdDay: 21,
    schedule: {
      studyDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
      minutesPerDay: 45,
      startDay: 21,
    },
    brief: {
      goalType: 'interview',
      targetDate: '2026-09-02',
      source: 'job-description',
      body: `# SQL Interview Prep

## Goal

Prepare Alex for the backend-engineer SQL screen by 2026-09-02. The supplied job description emphasizes production SQL, query plans, indexing, correctness around NULLs and duplicates, and clear trade-off explanations.

## Starting point

Alex is a mid-level frontend engineer with strong JavaScript fundamentals, rusty SQL, and no formal CS background. SELECT basics should return quickly; joins, grouping grain, NULL semantics, window functions, and optimization need deliberate practice.

## Learning constraints

- Use 45-minute weekday blocks and concrete datasets before theory.
- Keep explanations short, then ask Alex to predict row counts or write a query.
- Revisit misconceptions through fresh examples instead of repeating lectures.
- Finish with timed mixed drills and full mock interviews.
`,
    },
    source: { filename: 'job-description.md', text: SQL_JOB_DESCRIPTION },
    days: [
      {
        day: 1,
        title: 'SELECT fundamentals',
        completedOnDay: 20,
        topics: [{ topic: 'sql', concepts: ['select-basics'] }],
        subtopics: ['SELECT / FROM anatomy and aliases', 'DISTINCT and projection choices'],
      },
      {
        day: 2,
        title: 'Filtering with WHERE',
        completedOnDay: 19,
        topics: [{ topic: 'sql', concepts: ['where-clause', 'null-semantics'] }],
        subtopics: ['Comparison, BETWEEN, and IN predicates', 'Why NULL needs three-valued logic'],
      },
      {
        day: 3,
        title: 'Sorting, limits, and deduplication',
        completedOnDay: 18,
        topics: [{ topic: 'sql', concepts: ['order-by-limit', 'distinct-dedup'] }],
        subtopics: ['Mixed-direction ORDER BY', 'Top-N queries and duplicate control'],
      },
      {
        day: 4,
        title: 'The INNER JOIN mental model',
        completedOnDay: 16,
        topics: [{ topic: 'sql', concepts: ['inner-join'] }],
        subtopics: ['Match tables and join keys', 'Predicting row multiplication'],
      },
      {
        day: 5,
        title: 'Grouping grain and aggregates',
        completedOnDay: 15,
        topics: [{ topic: 'sql', concepts: ['group-by', 'aggregates'] }],
        subtopics: ['State the output grain first', 'COUNT, SUM, AVG, and NULL behavior'],
      },
      {
        day: 6,
        title: 'Join and NULL consolidation',
        completedOnDay: 14,
        topics: [{ topic: 'sql', concepts: ['inner-join', 'null-semantics'] }],
        subtopics: ['Join-then-filter reasoning', 'NULL-safe predicates and truth tables'],
      },
      {
        day: 7,
        title: 'HAVING and first window functions',
        completedOnDay: 12,
        topics: [{ topic: 'sql', concepts: ['having', 'window-functions', 'group-by'] }],
        subtopics: ['WHERE versus HAVING', 'ROW_NUMBER with PARTITION BY'],
      },
      {
        day: 8,
        title: 'Window ranking and CASE',
        completedOnDay: 11,
        topics: [{ topic: 'sql', concepts: ['window-functions', 'case-expressions'] }],
        subtopics: ['ROW_NUMBER, RANK, and DENSE_RANK', 'Conditional bucketing with CASE'],
      },
      {
        day: 9,
        title: 'Subqueries, indexes, and filter order',
        completedOnDay: 8,
        topics: [{ topic: 'sql', concepts: ['subqueries', 'indexes-basics', 'where-clause'] }],
        subtopics: ['Correlated and uncorrelated subqueries', 'Read a basic query plan', 'Fix the WHERE-before-JOIN gap'],
      },
      {
        day: 10,
        title: 'Multi-table joins and set operations',
        completedOnDay: 7,
        topics: [{ topic: 'sql', concepts: ['joins-multi-table', 'union-set-ops'] }],
        subtopics: ['Build three-table joins incrementally', 'UNION versus UNION ALL'],
      },
      {
        day: 11,
        title: 'LEFT JOINs and readable CTEs',
        completedOnDay: 5,
        topics: [{ topic: 'sql', concepts: ['left-join', 'cte'] }],
        subtopics: ['Preserve unmatched rows deliberately', 'Rewrite nested logic with WITH'],
      },
      {
        day: 12,
        title: 'Mock-interview gap drills',
        completedOnDay: 3,
        topics: [{ topic: 'sql', concepts: ['exists-in-vs-join', 'self-joins', 'union-set-ops'] }],
        subtopics: ['EXISTS and NULL-safe membership', 'Self-join recognition', 'Timed mixed-question recovery'],
      },
      {
        day: 13,
        title: 'LEFT JOIN edge cases',
        topics: [{ topic: 'sql', concepts: ['left-join', 'null-semantics', 'aggregates'] }],
        subtopics: ['COUNT over NULL-extended rows', 'NULL join keys and unmatched records', 'Explain the result before running it'],
      },
      {
        day: 14,
        title: 'Correlated subqueries in depth',
        topics: [{ topic: 'sql', concepts: ['subqueries', 'exists-in-vs-join'] }],
        subtopics: ['Outer-row references', 'Rewrite correlated work with EXISTS'],
      },
      {
        day: 15,
        title: 'Advanced CTE patterns',
        topics: [{ topic: 'sql', concepts: ['cte', 'subqueries'] }],
        subtopics: ['Stage complex transformations', 'Name intermediate grains clearly'],
      },
      {
        day: 16,
        title: 'Analytical windows',
        topics: [{ topic: 'sql', concepts: ['window-functions', 'group-by'] }],
        subtopics: ['Running totals and moving context', 'Windows over grouped results'],
      },
      {
        day: 17,
        title: 'Index design fundamentals',
        topics: [{ topic: 'sql', concepts: ['indexes-basics', 'query-optimization'] }],
        subtopics: ['Composite-index column order', 'Match indexes to real predicates'],
      },
      {
        day: 18,
        title: 'Query plans and optimization',
        topics: [{ topic: 'sql', concepts: ['query-optimization', 'indexes-basics'] }],
        subtopics: ['Spot scans and expensive operators', 'Optimize only after measuring'],
      },
      {
        day: 19,
        title: 'Sets and self joins under pressure',
        topics: [{ topic: 'sql', concepts: ['union-set-ops', 'self-joins'] }],
        subtopics: ['Deduplication across result sets', 'Hierarchy queries with aliases'],
      },
      {
        day: 20,
        title: 'Mixed backend SQL drills',
        topics: [{ topic: 'sql', concepts: ['inner-join', 'group-by', 'subqueries'] }],
        subtopics: ['Choose a query shape from prose', 'Narrate grain and row-count checks'],
      },
      {
        day: 21,
        title: 'Full mock interview',
        topics: [{ topic: 'sql', concepts: ['left-join', 'window-functions', 'query-optimization'] }],
        subtopics: ['Timed query-writing round', 'Explain correctness and performance trade-offs'],
      },
      {
        day: 22,
        title: 'Final review and interview strategy',
        topics: [{ topic: 'sql', concepts: ['null-semantics', 'exists-in-vs-join', 'indexes-basics'] }],
        subtopics: ['Repair the last weak spots', 'Build a concise interview-day checklist'],
      },
    ],
  },
  {
    track: 'python-dsa',
    createdDay: 10,
    schedule: {
      studyDays: ['mon', 'wed', 'fri'],
      minutesPerDay: 30,
      startDay: 10,
    },
    brief: {
      goalType: 'interview',
      source: 'none',
      body: `# Python DS&A

## Goal

Build enough Python fluency and data-structures pattern recognition for the DS&A screen that accompanies Alex's backend interviews.

## Starting point

Alex already reasons well in JavaScript but is new to interview-style Python. Complexity intuition is uneven; Python container syntax and the common array, hash-map, pointer, stack, recursion, tree, graph, heap, and dynamic-programming patterns need practice.

## Learning constraints

- Use focused 30-minute blocks on Monday, Wednesday, and Friday.
- Prefer short coding drills over long lectures.
- Call out Python-versus-JavaScript differences only when they affect correctness or complexity.
- Keep this secondary track from crowding out SQL preparation.
`,
    },
    days: [
      {
        day: 1,
        title: 'Complexity and Python arrays',
        completedOnDay: 10,
        topics: [{ topic: 'python', concepts: ['big-o', 'arrays-lists', 'list-comprehensions'] }],
        subtopics: ['Big-O from familiar JavaScript examples', 'List operations, slicing, and comprehensions'],
      },
      {
        day: 2,
        title: 'Strings and hash maps',
        completedOnDay: 8,
        topics: [{ topic: 'python', concepts: ['strings-py', 'hashmaps'] }],
        subtopics: ['Frequency maps and dictionary idioms', 'Immutable-string construction with join'],
      },
      {
        day: 3,
        title: 'Two-pointer patterns',
        topics: [{ topic: 'python', concepts: ['two-pointers', 'arrays-lists'] }],
        subtopics: ['Converging pointers on sorted input', 'State pointer invariants before coding'],
      },
      {
        day: 4,
        title: 'Sliding windows',
        topics: [{ topic: 'python', concepts: ['sliding-window', 'two-pointers'] }],
        subtopics: ['Fixed-size window updates', 'Variable-size shrink conditions'],
      },
      {
        day: 5,
        title: 'Stacks and queues',
        topics: [{ topic: 'python', concepts: ['stacks-queues'] }],
        subtopics: ['Balanced delimiters with a stack', 'Queue operations with deque'],
      },
      {
        day: 6,
        title: 'Recursion foundations',
        topics: [{ topic: 'python', concepts: ['recursion'] }],
        subtopics: ['Base cases and shrinking inputs', 'Trace the call stack by hand'],
      },
      {
        day: 7,
        title: 'Binary search templates',
        topics: [{ topic: 'python', concepts: ['binary-search', 'big-o'] }],
        subtopics: ['Boundary-safe exact search', 'Recognize search-on-answer problems'],
      },
      {
        day: 8,
        title: 'Sorting and custom keys',
        topics: [{ topic: 'python', concepts: ['sorting', 'arrays-lists'] }],
        subtopics: ['Stable sorting and key functions', 'Compare merge sort and quicksort'],
      },
      {
        day: 9,
        title: 'Linked-list mechanics',
        topics: [{ topic: 'python', concepts: ['linked-lists'] }],
        subtopics: ['Pointer-safe traversal', 'Iterative in-place reversal'],
      },
      {
        day: 10,
        title: 'Binary trees',
        topics: [{ topic: 'python', concepts: ['trees-basics', 'recursion'] }],
        subtopics: ['DFS traversal orders', 'Recursive and iterative tree walks'],
      },
      {
        day: 11,
        title: 'Graphs and heaps',
        topics: [{ topic: 'python', concepts: ['graphs-basics', 'heaps'] }],
        subtopics: ['Adjacency lists and visited sets', 'Priority queues with heapq'],
      },
      {
        day: 12,
        title: 'Dynamic programming and mock drill',
        topics: [{ topic: 'python', concepts: ['dp-intro', 'arrays-lists'] }],
        subtopics: ['Define state and transitions', 'Timed mixed-pattern interview drill'],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Misconceptions: 3 open + 4 resolved (plans/02 §7). The WHERE-before-JOIN
// one is the demo's on-camera beat — its title must match plans/07 §1.
// ---------------------------------------------------------------------------

export const MISCONCEPTIONS: MisconceptionSeed[] = [
  {
    id: 'where-join',
    topic: 'sql',
    title: 'Believes WHERE filters before JOIN completes',
    concepts: ['inner-join', 'where-clause'],
    openedDay: 8,
    evidence: 'Predicted 3 rows on quiz {q}; actual 5 — filtered mentally before joining.',
    remediation: 'Contrast WHERE vs ON with a 2-table walkthrough, then re-quiz.',
  },
  {
    id: 'union-dup',
    topic: 'sql',
    title: 'Thinks UNION keeps duplicate rows (confuses it with UNION ALL)',
    concepts: ['union-set-ops'],
    openedDay: 2,
    evidence: 'Mock exam set-ops question: predicted duplicates in the merged result.',
    remediation: 'Drill UNION vs UNION ALL on a pair of overlapping result sets.',
  },
  {
    id: 'null-eq',
    topic: 'sql',
    title: 'Expects NULL = NULL to evaluate true in join conditions',
    concepts: ['null-semantics', 'left-join'],
    openedDay: 1,
    evidence: 'Predicted NULL-keyed rows would match each other in {ex}.',
    remediation: 'Walk three-valued logic, then IS NULL / IS NOT DISTINCT FROM patterns.',
  },
  {
    id: 'null-where',
    topic: 'sql',
    title: 'Believed NULL comparisons behave like ordinary equality in WHERE',
    concepts: ['where-clause', 'null-semantics'],
    openedDay: 18,
    resolvedDay: 14,
    evidence: 'Expected `WHERE middle_name = NULL` to match rows on quiz {q}.',
    remediation: 'IS NULL drill plus a three-valued logic truth table.',
  },
  {
    id: 'groupby-cols',
    topic: 'sql',
    title: 'Thought any column can be selected without aggregating under GROUP BY',
    concepts: ['group-by'],
    openedDay: 15,
    resolvedDay: 12,
    evidence: 'Selected a non-grouped column in {ex} and expected a single row per group.',
    remediation: 'Show the grouped-rows mental model; every selected column must be grain or aggregate.',
  },
  {
    id: 'pk-order',
    topic: 'sql',
    title: 'Thought PRIMARY KEY implies physical index ordering',
    concepts: ['indexes-basics'],
    openedDay: 9,
    resolvedDay: 8,
    evidence: 'Claimed ORDER BY on the PK is always free during the indexing intro.',
    remediation: 'Separate logical constraint from storage layout; show a query plan.',
  },
  {
    id: 'append-on',
    topic: 'python',
    title: 'Assumed list.append is O(n) and avoided it inside loops',
    concepts: ['arrays-lists', 'big-o'],
    openedDay: 10,
    resolvedDay: 4,
    evidence: 'Pre-sized lists "for performance" in {ex}; cited append as linear.',
    remediation: 'Amortized-growth explanation plus a quick timing demo.',
  },
];

// ---------------------------------------------------------------------------
// Sessions (one log per sitting; the day-1 SQL one carries THE next_time
// pointer that becomes the dashboard Continue CTA, plans/02 §7)
// ---------------------------------------------------------------------------

export const NEXT_TIME_POINTER = 'LEFT JOIN edge cases with NULLs';

export const SESSIONS: SessionSeed[] = [
  {
    day: 20, slug: 'sql-select-basics', mode: 'learn', track: 'sql-interview', roadmapDay: 1,
    title: 'SELECT fundamentals', topics: ['sql'], duration: '30m', concepts: ['select-basics'],
    nextTime: 'WHERE clause fundamentals',
    narrative: 'First sitting. Projections, aliases and DISTINCT on the practice schema. Alex moves fast with concrete examples in front of them and stalls on abstract definitions — leading with runnable queries worked well.',
  },
  {
    day: 19, slug: 'sql-where', mode: 'learn', track: 'sql-interview', roadmapDay: 2,
    title: 'Filtering with WHERE', topics: ['sql'], duration: '35m', concepts: ['select-basics', 'where-clause'],
    nextTime: 'Sorting and set hygiene: ORDER BY, LIMIT, DISTINCT',
    narrative: 'Warmed up with a SELECT recap, then filtering. Comparison predicates landed quickly; BETWEEN and IN took one worked example each. NULL comparisons flagged as a likely trouble spot — watch it.',
  },
  {
    day: 18, slug: 'sql-filtering-sorting', mode: 'learn', track: 'sql-interview', roadmapDay: 3,
    title: 'Sorting, limits, and deduplication', topics: ['sql'], duration: '45m', concepts: ['where-clause', 'order-by-limit', 'distinct-dedup', 'null-semantics'],
    nextTime: 'Introduce joins on the orders/customers pair',
    narrative: 'Dense sitting: ORDER BY with mixed directions, LIMIT for top-N, DISTINCT, and a first bruising encounter with NULL comparisons — the equality misconception is now logged and scheduled for remediation.',
  },
  {
    day: 16, slug: 'sql-joins-begin', mode: 'learn', track: 'sql-interview', roadmapDay: 4,
    title: 'The INNER JOIN mental model', topics: ['sql'], duration: '40m', concepts: ['inner-join', 'select-basics'],
    nextTime: 'Row-multiplication drill, then join-filter ordering',
    narrative: 'Started INNER JOIN. Rows multiplying on duplicate keys genuinely surprised Alex — spent most of the sitting drawing match tables by hand. Ended frustrated but with the mechanic half-formed. Kept the SELECT review light.',
  },
  {
    day: 15, slug: 'sql-joins-and-grouping', mode: 'learn', track: 'sql-interview', roadmapDay: 5,
    title: 'Grouping grain and aggregates', topics: ['sql'], duration: '45m', concepts: ['inner-join', 'group-by', 'aggregates', 'order-by-limit'],
    nextTime: 'Consolidate joins; GROUP BY grain drill',
    narrative: 'Joins improving with the match-table habit. Introduced GROUP BY and aggregates together; the non-grouped-column misconception surfaced immediately and is logged. Aggregates themselves came easily.',
  },
  {
    day: 14, slug: 'sql-consolidation', mode: 'learn', track: 'sql-interview', roadmapDay: 6,
    title: 'Join and NULL consolidation', topics: ['sql'], duration: '40m', concepts: ['inner-join', 'group-by', 'where-clause', 'null-semantics', 'string-functions'],
    nextTime: 'Aggregates depth, then HAVING',
    narrative: 'Consolidation day. The NULL-equality misconception is RESOLVED — Alex reproduced the three-valued logic table and fixed the quiz query unprompted. Joins at 0.48 and climbing steadily.',
  },
  {
    day: 12, slug: 'sql-having-windows', mode: 'learn', track: 'sql-interview', roadmapDay: 7,
    title: 'HAVING and first window functions', topics: ['sql'], duration: '45m', concepts: ['group-by', 'having', 'window-functions', 'aggregates'],
    nextTime: 'Window functions second pass; keep join reps going',
    narrative: 'GROUP BY misconception resolved during review — grain-first thinking is sticking. Introduced HAVING and a first taste of window functions; ROW_NUMBER made sense, PARTITION BY syntax did not stick yet.',
  },
  {
    day: 11, slug: 'sql-windows-case', mode: 'learn', track: 'sql-interview', roadmapDay: 8,
    title: 'Window ranking and CASE', topics: ['sql'], duration: '35m', concepts: ['window-functions', 'case-expressions', 'inner-join', 'select-basics'],
    nextTime: 'Multi-table joins',
    narrative: 'Window functions second pass went better — ranking trio differences now recitable. CASE expressions introduced via a bucketing exercise. Join review keeps the streak of small daily reps.',
  },
  {
    day: 10, slug: 'python-kickoff', mode: 'learn', track: 'python-dsa', roadmapDay: 1,
    title: 'Python DS&A kickoff', topics: ['python', 'sql'], duration: '50m', concepts: ['big-o', 'arrays-lists', 'list-comprehensions', 'joins-multi-table', 'window-functions'],
    nextTime: 'Python containers depth; SQL subqueries',
    narrative: 'Added the python-dsa track — interviews will have a DS&A screen too. Big-O intuition is decent from JS experience; the append-is-O(n) belief is logged as a misconception. On the SQL side, multi-table joins opened smoothly.',
  },
  {
    day: 9, slug: 'sql-subqueries-indexes', mode: 'learn', track: 'sql-interview', roadmapDay: 9,
    title: 'Subqueries and index basics', topics: ['sql', 'python'], duration: '45m', concepts: ['subqueries', 'having', 'indexes-basics', 'strings-py', 'recursion'],
    nextTime: 'WHERE vs ON — the join-filter distinction needs a direct hit',
    narrative: 'Subqueries opened well. First indexing pass; the PRIMARY-KEY-implies-ordering claim is logged. Python strings and recursion basics slotted into the morning block without friction.',
  },
  {
    day: 8, slug: 'python-hashmaps-strings', mode: 'learn', track: 'python-dsa', roadmapDay: 2,
    title: 'Strings and hash maps', topics: ['python'], duration: '30m', concepts: ['strings-py', 'hashmaps'],
    nextTime: 'Two-pointer patterns on sorted arrays',
    narrative: 'Second focused Python block. Built a frequency map with dict.get, rewrote repeated string concatenation with join, and solved two-sum cleanly. Python container syntax is starting to feel natural.',
  },
  {
    day: 8, slug: 'sql-join-filtering', mode: 'learn', track: 'sql-interview', roadmapDay: 9,
    title: 'Fixing the WHERE-before-JOIN gap', topics: ['sql', 'python'], duration: '45m', concepts: ['inner-join', 'where-clause', 'indexes-basics', 'hashmaps'],
    nextTime: 'Multi-table join practice; python hashmap drills',
    narrative: 'The WHERE-before-JOIN misconception is now logged explicitly after the row-count prediction miss — remediation planned. Yesterday\'s PK-ordering confusion resolved with a query plan. Python hashmaps introduced; two-sum solved.',
  },
  {
    day: 7, slug: 'sql-multi-joins', mode: 'learn', track: 'sql-interview', roadmapDay: 10,
    title: 'Multi-table joins and set operations', topics: ['sql', 'python'], duration: '50m', concepts: ['joins-multi-table', 'subqueries', 'union-set-ops', 'group-by', 'arrays-lists'],
    nextTime: 'CTEs and LEFT JOIN',
    narrative: 'Three-table joins built incrementally with row-count checks — the discipline from the early join struggles is paying off. Set operations introduced; UNION default behavior still not internalized.',
  },
  {
    day: 6, slug: 'sql-left-join-cte', mode: 'learn', track: 'sql-interview', roadmapDay: 11,
    title: 'LEFT JOINs and readable CTEs', topics: ['sql', 'python'], duration: '45m', concepts: ['left-join', 'cte', 'inner-join', 'select-basics', 'binary-search'],
    nextTime: 'LEFT JOIN aggregates; CTE practice',
    narrative: 'LEFT JOIN opened — which side survives took two tries but the retention-query framing helped. First CTE rewrite made the nested subquery readable. Binary search template started on the python side.',
  },
  {
    day: 5, slug: 'review-sprint', mode: 'review', track: 'sql-interview', roadmapDay: 11,
    title: 'Left joins — revisited', topics: ['sql', 'python'], duration: '40m', concepts: ['order-by-limit', 'distinct-dedup', 'aggregates', 'joins-multi-table', 'recursion', 'list-comprehensions', 'hashmaps'],
    nextTime: 'Second review block, then mock exam',
    narrative: 'Deliberate review sprint ahead of the first mock exam: cleared the whole due queue. Everything held or improved — aggregates and ORDER BY are approaching solid. Python morning block steady.',
  },
  {
    day: 4, slug: 'sql-preexam-drills', mode: 'learn', track: 'sql-interview', roadmapDay: 12,
    title: 'Pre-exam join drills', topics: ['sql', 'python'], duration: '55m', concepts: ['inner-join', 'left-join', 'subqueries', 'cte', 'having', 'self-joins', 'two-pointers', 'arrays-lists', 'big-o'],
    nextTime: 'Light day, then the mock',
    narrative: 'Longest sitting so far. Join reps, subquery review, first self-join, and CTE practice. The python append misconception is RESOLVED after an amortized-growth demo. Alex is visibly more confident than two weeks ago.',
  },
  {
    day: 3, slug: 'sql-gaps', mode: 'learn', track: 'sql-interview', roadmapDay: 12,
    title: 'Closing the pre-exam gaps', topics: ['sql', 'python'], duration: '35m', concepts: ['exists-in-vs-join', 'null-semantics', 'union-set-ops', 'case-expressions', 'stacks-queues', 'sorting'],
    nextTime: 'Mock exam — sql-interview track',
    narrative: 'Filled pre-exam gaps: EXISTS vs IN with the NULL-safety argument, NULL semantics third pass, set ops. Kept it deliberately short to stay fresh for tomorrow\'s mock.',
  },
  {
    day: 2, slug: 'sql-mock-exam-1', mode: 'exam', track: 'sql-interview', roadmapDay: 12,
    title: 'SQL mock interview 1', topics: ['sql'], duration: '60m', concepts: ['inner-join', 'left-join', 'group-by', 'aggregates', 'subqueries', 'null-semantics', 'union-set-ops', 'select-basics', 'where-clause'],
    nextTime: 'Review the missed set-ops question; LEFT JOIN depth',
    narrative: 'First full mock on the sql-interview track: 71/100. Joins and grouping carried it; set operations and the LEFT JOIN aggregate question gave the most trouble. Readiness jumped {examDelta} — the two weeks of join work shows. UNION duplicate misconception logged from the exam evidence.',
  },
  {
    day: 1, slug: 'sql-left-join', mode: 'learn', track: 'sql-interview', roadmapDay: 13,
    title: 'LEFT JOIN edge cases', topics: ['sql'], duration: '30m', concepts: ['left-join', 'null-semantics'],
    nextTime: NEXT_TIME_POINTER,
    narrative: 'Post-exam follow-up on the weakest join: LEFT JOIN with aggregates. Good progress on which side survives and COUNT over NULL-extended rows, but NULL-keyed matching tripped Alex again — logged as an open misconception. Prime target for next session.',
  },
];

// ---------------------------------------------------------------------------
// Phrase banks (fillers + generic assessment bullets). Templates may use
// {concept}, {ex}, {q}, {days} slots.
// ---------------------------------------------------------------------------

export const GENERIC_LEARN_BULLETS = [
  'Solved {ex} (medium) without hints',
  'Solved {ex} after one nudge on the setup',
  'Worked {ex} to green; second attempt after an off-by-one',
  '{score} on quiz {q}; missed the trickiest case',
  'Aced quiz {q} — all {n} questions',
  'Walked through a worked example, then reproduced it cold',
  'Explained the idea back in plain words — mostly accurate',
  'Built the query/function incrementally, testing at each step',
  'Predicted output correctly before running — twice',
];

export const GENERIC_REVIEW_BULLETS = [
  'Recall check passed; interval extended to {days}d',
  'Reviewed via two quick drill questions — both correct',
  'Re-derived the rule from scratch rather than reciting it',
  'Held up under a harder variant than last time',
  'Short spaced-repetition rep; no hesitation this time',
];

/** Evidence notes for concepts assessed inside the mock exam. */
export const EXAM_EVIDENCE_BULLETS = [
  'Mock exam 1: solved cleanly under time pressure',
  'Mock exam 1: correct with one minor slip on the way',
  'Assessed in mock exam 1 — details in the exam record',
  'Mock exam 1: the weeks of reps showed',
  'Mock exam 1: partial credit — gap logged for review',
];

export const FILLER_NOTES = [
  'Quick recall check on {concept} during coffee — clean.',
  'Skimmed yesterday\'s notes on {concept}; nothing had faded overnight.',
  'Alex asked a sharp follow-up about {concept} — curiosity is a good sign.',
  'Ran one warm-up rep on {concept} before the main block.',
  'Re-read the {concept} summary aloud; recall was immediate.',
  'Traced through an old {concept} exercise to confirm it stuck.',
  'Two-minute flashcard pass over {concept}; scheduled the next rep.',
  'Looked over the review queue and picked {concept} for a quick rep.',
  'Compared two phrasings of the {concept} rule; kept the sharper one.',
  'One quick {concept} question from memory — correct, with reasoning.',
];

/** Filler commit headlines; {id} is the kebab-case concept id. */
export const FILLER_HEADLINES = [
  'quick recall check on {id}',
  'warm-up rep: {id}',
  'notes pass over {id}',
  'flashcard sweep: {id}',
  'queue triage, then one rep on {id}',
];

/** Session-wrap commit headlines (the session log rides these commits). */
export const SESSION_WRAP_HEADLINES = [
  'session notes — {slug}',
  'session log: {slug}',
  'wrapped the sitting; logged the summary',
  'session summary and next-step pointer',
  'end-of-session notes — {slug}',
  'logged the sitting and set the next step',
];
