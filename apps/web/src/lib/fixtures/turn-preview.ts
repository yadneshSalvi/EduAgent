import type { MemoryCommit, WsEvent } from '@eduagent/shared';

/**
 * Hand-authored WsEvent fixtures for the dev harness (/app/dev/turn-preview)
 * and the useTurnStream reducer tests. Every event conforms to the shared
 * `wsEventSchema` — a test asserts this, so the harness can never drift from
 * the real contract (task #11 builds the server side of the same schema).
 */
export interface ReplayStep {
  /** Milliseconds after replay start. */
  at: number;
  event: WsEvent;
}

// ---------------------------------------------------------------------------
// The memory commit — learn(sql), realistic multi-file YAML/MD diff (02 §3)
// ---------------------------------------------------------------------------

export const GREETING_COMMIT_DIFF = `diff --git a/topics/sql/mastery.yaml b/topics/sql/mastery.yaml
index 3f1c2aa..b48e901 100644
--- a/topics/sql/mastery.yaml
+++ b/topics/sql/mastery.yaml
@@ -4,14 +4,14 @@ concepts:
   inner-join:
     name: INNER JOIN
-    mastery: 0.40
-    last_assessed: 2026-07-14
-    evidence_count: 2
+    mastery: 0.72
+    last_assessed: 2026-07-17
+    evidence_count: 4
   left-join:
     name: LEFT JOIN
-    mastery: 0.35
-    last_assessed: 2026-07-14
+    mastery: 0.55
+    last_assessed: 2026-07-17
     review_due: 2026-07-20
diff --git a/topics/sql/misconceptions.md b/topics/sql/misconceptions.md
index 91d2f10..c7aa3e4 100644
--- a/topics/sql/misconceptions.md
+++ b/topics/sql/misconceptions.md
@@ -1,8 +1,9 @@
 # Misconceptions — sql

-## OPEN: WHERE vs ON in outer joins
-Believes WHERE and ON are interchangeable in LEFT JOIN queries.
-First seen: 2026-07-14 (quiz q2).
+## RESOLVED (2026-07-17): WHERE vs ON in outer joins
+Believed WHERE and ON are interchangeable in LEFT JOIN queries.
+First seen: 2026-07-14 (quiz q2).
+Resolved after predicting row counts correctly on a filtered LEFT JOIN.
diff --git a/sessions/2026-07-17-sql.md b/sessions/2026-07-17-sql.md
new file mode 100644
index 0000000..7d3b112
--- /dev/null
+++ b/sessions/2026-07-17-sql.md
@@ -0,0 +1,10 @@
+# Session — 2026-07-17 · sql
+
+- Focus: INNER vs LEFT JOIN semantics; ON vs WHERE placement.
+- Resolved the WHERE-vs-ON misconception with a row-count prediction drill.
+- Exercises: ex-014 (passed), ex-015 (passed, used a self-join unprompted).
+- Mastery: inner-join 0.40→0.72, left-join 0.35→0.55.
+
+## Next time
+- LEFT JOIN edge cases: filters on the right table, NULL-safe aggregation.
+- Introduce RIGHT/FULL OUTER via the review queue.
`;

export const GREETING_COMMIT: MemoryCommit = {
  sha: 'a3f8c21d9e5b4076c1d2a8f30b6e94d7c5a1f082',
  type: 'learn',
  topic: 'sql',
  headline: 'ON vs WHERE misconception resolved; inner-join 0.40→0.72, left-join 0.35→0.55',
  bullets: [
    'Corrected the belief that WHERE filters before the join in outer joins — walked through a LEFT JOIN where the filter belongs in ON.',
    'Two graded exercises passed on the first run; the second used a self-join unprompted.',
    'Queued left-join edge cases for review in 3 days.',
  ],
  deltas: [
    { concept: 'inner-join', from: 0.4, to: 0.72 },
    { concept: 'left-join', from: 0.35, to: 0.55 },
  ],
  stats: { filesChanged: 3, insertions: 19, deletions: 8 },
  diff: GREETING_COMMIT_DIFF,
};

// ---------------------------------------------------------------------------
// Greeting turn: reasoning → activity chips → streamed markdown → commit
// ---------------------------------------------------------------------------

const GREETING_TEXT = `Welcome back, Alex. Last Tuesday you mixed up \`WHERE\` and \`ON\` in outer joins — today we fix that for good.

Quick check before we build on it. Given:

\`\`\`sql
SELECT c.name, o.total
FROM customers c
LEFT JOIN orders o
  ON o.customer_id = c.id
WHERE o.total > 100;
\`\`\`

How many rows survive for a customer with **no orders** — and why?`;

const REPLY_TEXT = `Exactly — the \`WHERE\` filter turns that LEFT JOIN into an INNER JOIN: the row with a NULL \`o.total\` fails the comparison and is dropped.

Move the condition into the \`ON\` clause and orderless customers survive with a NULL total. Want to try rewriting it that way?`;

/** Timestamp of a script's final step (scripts are time-ordered). */
function lastAt(steps: ReplayStep[]): number {
  return steps[steps.length - 1]?.at ?? 0;
}

/** Splits message text into small delta chunks at word boundaries. */
function messageDeltas(
  itemId: string,
  text: string,
  startAt: number,
  everyMs: number,
): ReplayStep[] {
  const words = text.split(/(?<=\s)/);
  const steps: ReplayStep[] = [];
  const chunkSize = 3;
  for (let i = 0; i < words.length; i += chunkSize) {
    steps.push({
      at: startAt + (i / chunkSize) * everyMs,
      event: { type: 'message.delta', itemId, text: words.slice(i, i + chunkSize).join('') },
    });
  }
  steps.push({
    at: startAt + Math.ceil(words.length / chunkSize) * everyMs + 100,
    event: { type: 'message.completed', itemId, text },
  });
  return steps;
}

const greetingDeltas = messageDeltas('item-greeting-01', GREETING_TEXT, 1900, 55);
const greetingDone = lastAt(greetingDeltas);

export const greetingTurnScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 200,
    event: { type: 'activity', kind: 'tool', label: 'reading your memory', status: 'started' },
  },
  { at: 550, event: { type: 'reasoning.delta', text: 'Recalling last session — ' } },
  {
    at: 850,
    event: { type: 'reasoning.delta', text: 'the ON vs WHERE misconception is still open; ' },
  },
  { at: 1200, event: { type: 'reasoning.delta', text: 'planning a row-count prediction drill…' } },
  {
    at: 1350,
    event: { type: 'activity', kind: 'tool', label: 'reading your memory', status: 'completed' },
  },
  {
    at: 1450,
    event: { type: 'activity', kind: 'exec', label: 'checking your review queue', status: 'started' },
  },
  {
    at: 1750,
    event: {
      type: 'activity',
      kind: 'exec',
      label: 'checking your review queue',
      status: 'completed',
    },
  },
  ...greetingDeltas,
  {
    at: greetingDone + 400,
    event: { type: 'activity', kind: 'tool', label: 'updating memory', status: 'started' },
  },
  {
    at: greetingDone + 1400,
    event: { type: 'activity', kind: 'tool', label: 'updating memory', status: 'completed' },
  },
  { at: greetingDone + 1600, event: { type: 'memory.commit', commit: GREETING_COMMIT } },
  {
    at: greetingDone + 1900,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

const replyDeltas = messageDeltas('item-reply-01', REPLY_TEXT, 900, 55);

export const replyTurnScript: ReplayStep[] = [
  { at: 120, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 350,
    event: { type: 'reasoning.delta', text: 'Checking the prediction against the join semantics…' },
  },
  ...replyDeltas,
  {
    at: lastAt(replyDeltas) + 300,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

/** A turn that fails — exercises the turn.error → retry UI path. */
export const errorTurnScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  { at: 400, event: { type: 'reasoning.delta', text: 'Reading the workspace…' } },
  {
    at: 1200,
    event: {
      type: 'turn.error',
      message: 'The tutor lost connection mid-thought. Your memory is intact.',
      retryable: true,
    },
  },
];

/**
 * Onboarding finale: the very first commit — profile birth (topic-less commits
 * broadcast with topic "general", memory-commit.ts).
 */
export const ONBOARDING_COMMIT: MemoryCommit = {
  sha: 'f10ab32c47d8e95f6a0b1c2d3e4f5a6b7c8d9e0f',
  type: 'profile',
  topic: 'general',
  headline: 'initialize learner model for Alex',
  bullets: [
    'Goal: pass a backend interview loop in ~6 weeks (SQL-heavy).',
    'Background: 3 years of application code; comfortable reading queries, rusty writing joins.',
    'Baseline: inner-join 0.40, left-join 0.35, group-by 0.60 from a 5-question quiz.',
  ],
  deltas: [],
  stats: { filesChanged: 3, insertions: 25, deletions: 0 },
  diff: `diff --git a/profile.md b/profile.md
new file mode 100644
index 0000000..1a2b3c4
--- /dev/null
+++ b/profile.md
@@ -0,0 +1,9 @@
+# Alex
+
+- Goal: pass a backend interview loop (~6 weeks out), SQL-heavy.
+- Background: 3 years of application code; reads SQL fine, rusty writing joins.
+- Prefers: small chunks, real exercises over theory.
+
+## Tracks
+- sql-interview (active)
+- python (queued)
diff --git a/topics/sql/mastery.yaml b/topics/sql/mastery.yaml
new file mode 100644
index 0000000..3f1c2aa
--- /dev/null
+++ b/topics/sql/mastery.yaml
@@ -0,0 +1,11 @@
+topic: sql
+concepts:
+  inner-join:
+    name: INNER JOIN
+    mastery: 0.40
+  left-join:
+    name: LEFT JOIN
+    mastery: 0.35
+  group-by:
+    name: GROUP BY
+    mastery: 0.60
diff --git a/review/queue.yaml b/review/queue.yaml
new file mode 100644
index 0000000..9e8d7c6
--- /dev/null
+++ b/review/queue.yaml
@@ -0,0 +1,5 @@
+queue:
+  - concept: sql/left-join
+    due: 2026-07-20
+  - concept: sql/inner-join
+    due: 2026-07-21
`,
};

// ---------------------------------------------------------------------------
// Onboarding interview (preview mode) — Goal → Background → Baseline → Ready
// ---------------------------------------------------------------------------

const ONBOARDING_GREETING = `Hi — I'm your tutor. Before we start, I want to build my memory of you: three quick questions, then a tiny baseline check. Everything you tell me becomes a file I keep — you can read every word of it later.

**First: what are you working toward?** An interview loop, a course, a project — and roughly when?`;

const ONBOARDING_BACKGROUND = `Good — that's a workable runway.

**Second: where are you starting from?** What have you built or studied that feels related?`;

const ONBOARDING_BASELINE = `That gives me a picture — let's calibrate it. Two quick questions, zero stakes:

1. In one line: what's the difference between an \`INNER JOIN\` and a \`LEFT JOIN\`?
2. Would you reach for \`GROUP BY\` or a window function to show each order **with** its customer's running total?`;

const ONBOARDING_FINALE = `Perfect — I know enough to start. Writing your profile now; you can watch me do it.`;

export const onboardingGreetingScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-onboarding-thread' } },
  { at: 400, event: { type: 'reasoning.delta', text: 'Fresh workspace — starting the interview…' } },
  ...messageDeltas('item-ob-greeting', ONBOARDING_GREETING, 1100, 50),
  { at: 6500, event: { type: 'turn.completed', threadId: 'dev-onboarding-thread' } },
];

function onboardingReply(itemId: string, text: string, extra: ReplayStep[] = []): ReplayStep[] {
  const deltas = messageDeltas(itemId, text, 800, 50);
  const done = lastAt(deltas);
  return [
    { at: 100, event: { type: 'turn.started', threadId: 'dev-onboarding-thread' } },
    ...deltas,
    ...extra.map((step) => ({ ...step, at: done + step.at })),
    {
      at: done + (extra.length > 0 ? lastAt(extra) + 400 : 200),
      event: { type: 'turn.completed' as const, threadId: 'dev-onboarding-thread' },
    },
  ];
}

/** Consumed one per user send: Background → Baseline → profile commit. */
export const onboardingReplyScripts: ReplayStep[][] = [
  onboardingReply('item-ob-background', ONBOARDING_BACKGROUND),
  onboardingReply('item-ob-baseline', ONBOARDING_BASELINE),
  onboardingReply('item-ob-finale', ONBOARDING_FINALE, [
    {
      at: 300,
      event: { type: 'activity', kind: 'tool', label: 'writing your profile', status: 'started' },
    },
    {
      at: 1600,
      event: { type: 'activity', kind: 'tool', label: 'writing your profile', status: 'completed' },
    },
    { at: 1900, event: { type: 'memory.commit', commit: ONBOARDING_COMMIT } },
  ]),
];

