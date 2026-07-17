import type {
  ArtifactPayload,
  ExercisePayload,
  MemoryCommit,
  QuizPayload,
  WsEvent,
} from '@eduagent/shared';

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
    event: {
      type: 'activity',
      kind: 'exec',
      label: 'checking your review queue',
      status: 'started',
    },
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
      threadId: 'dev-preview-thread',
      message: 'The tutor lost connection mid-thought. Your memory is intact.',
      retryable: true,
    },
  },
];

// ---------------------------------------------------------------------------
// Workbench fixtures (Phase 2B): exercise push → failed attempt → passed
// attempt + assessment; a 3-question quiz; an artifact. Same contract rule as
// above — every event must survive wsEventSchema (asserted in tests).
// ---------------------------------------------------------------------------

export const EXERCISE_PAYLOAD: ExercisePayload = {
  id: 'ex-016',
  title: 'Orderless customers, kept',
  language: 'sql',
  prompt_md: `Write a query that lists **every** customer with the total of their orders over $100 — customers with no qualifying orders must still appear, with a NULL total.

Tables: \`customers(id, name)\` · \`orders(id, customer_id, total)\`.
Return columns: \`name\`, \`total\`.

This is the exact trap from Tuesday: where does the \`total > 100\` filter belong?`,
  starter_code: 'SELECT c.name, o.total\nFROM customers c\n-- your join here\n',
  concepts: ['left-join', 'sql/on-vs-where'],
  difficulty: 'medium',
};

const EXERCISE_INTRO_TEXT = `Talk is cheap — prove it. I've put an exercise in your workbench: the same LEFT JOIN trap, but this time *you* write the query.

I already wrote hidden tests for it, including the case that catches the WHERE-clause mistake. ⌘↵ in the editor submits.`;

const exerciseIntroDeltas = messageDeltas('item-exercise-intro', EXERCISE_INTRO_TEXT, 1500, 55);

export const exerciseTurnScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 300,
    event: { type: 'reasoning.delta', text: 'They predicted the row counts correctly — ' },
  },
  { at: 650, event: { type: 'reasoning.delta', text: 'time to make them write the join…' } },
  {
    at: 800,
    event: { type: 'activity', kind: 'tool', label: 'writing hidden tests', status: 'started' },
  },
  {
    at: 1400,
    event: { type: 'activity', kind: 'tool', label: 'writing hidden tests', status: 'completed' },
  },
  ...exerciseIntroDeltas,
  {
    at: lastAt(exerciseIntroDeltas) + 200,
    event: { type: 'workbench.exercise', exercise: EXERCISE_PAYLOAD },
  },
  {
    at: lastAt(exerciseIntroDeltas) + 500,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

const EXERCISE_FAIL_TEXT = `Close — your join is right, but look at what happened to Dana (no orders): your \`WHERE o.total > 100\` filters her NULL row out after the join. That's the LEFT-JOIN-turned-INNER-JOIN trap again.

Move the condition into the \`ON\` clause and run it once more.`;

const exerciseFailDeltas = messageDeltas('item-exercise-fail', EXERCISE_FAIL_TEXT, 2600, 55);

export const exerciseFailTurnScript: ReplayStep[] = [
  { at: 200, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 500,
    event: { type: 'activity', kind: 'exec', label: 'running hidden tests', status: 'started' },
  },
  {
    at: 2200,
    event: { type: 'activity', kind: 'exec', label: 'running hidden tests', status: 'completed' },
  },
  ...exerciseFailDeltas,
  {
    at: lastAt(exerciseFailDeltas) + 200,
    event: {
      type: 'exercise.graded',
      exerciseId: 'ex-016',
      verdict: 'failed',
      feedback: '2 of 3 hidden tests failed — customers without orders vanish from your result.',
    },
  },
  {
    at: lastAt(exerciseFailDeltas) + 500,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

const EXERCISE_PASS_TEXT = `All three hidden tests pass — including the one with a customer who has *only* sub-$100 orders. You kept her row and nulled her total, which is exactly the ON-vs-WHERE distinction doing its job.

That's the misconception closed with working code, not just a right answer. I'm recording it.`;

const exercisePassDeltas = messageDeltas('item-exercise-pass', EXERCISE_PASS_TEXT, 2600, 55);

export const exercisePassTurnScript: ReplayStep[] = [
  { at: 200, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 500,
    event: { type: 'activity', kind: 'exec', label: 'running hidden tests', status: 'started' },
  },
  {
    at: 2200,
    event: { type: 'activity', kind: 'exec', label: 'running hidden tests', status: 'completed' },
  },
  ...exercisePassDeltas,
  {
    at: lastAt(exercisePassDeltas) + 200,
    event: {
      type: 'exercise.graded',
      exerciseId: 'ex-016',
      verdict: 'passed',
      feedback: 'All 3 hidden tests passed on attempt 2.',
    },
  },
  {
    at: lastAt(exercisePassDeltas) + 700,
    event: {
      type: 'assessment.recorded',
      concept_deltas: [
        {
          topic: 'sql',
          concept: 'left-join',
          from: 0.55,
          to: 0.68,
          evidence: 'ex-016 passed on attempt 2 after fixing a WHERE→ON filter placement',
        },
        {
          topic: 'sql',
          concept: 'on-vs-where',
          from: 0.45,
          to: 0.7,
          evidence: 'diagnosed the dropped-NULL-row failure unaided on the second attempt',
        },
      ],
      misconceptions_resolved: ['WHERE vs ON in outer joins'],
    },
  },
  {
    at: lastAt(exercisePassDeltas) + 1100,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

export const QUIZ_PAYLOAD: QuizPayload = {
  id: 'quiz-007',
  concepts: ['left-join', 'inner-join'],
  questions: [
    {
      id: 'q1',
      type: 'mcq',
      prompt_md:
        'A `LEFT JOIN` with `o.total > 100` in the **WHERE** clause behaves like which join?',
      options: [
        'A LEFT JOIN — unmatched customers survive',
        'An INNER JOIN — unmatched customers are dropped',
        'A CROSS JOIN — every pairing appears',
        'A FULL OUTER JOIN — both sides survive',
      ],
      answer: 'An INNER JOIN — unmatched customers are dropped',
    },
    {
      id: 'q2',
      type: 'predict_output',
      prompt_md: `\`customers\` has 4 rows. Exactly one customer has orders — 2 of them. What single number does this return?

\`\`\`sql
SELECT count(*)
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id;
\`\`\``,
      answer: '5',
    },
    {
      id: 'q3',
      type: 'short',
      prompt_md:
        'In one sentence: why does moving a right-table filter from `WHERE` to `ON` change the row count of a LEFT JOIN?',
    },
  ],
};

const QUIZ_INTRO_TEXT = `Before we build further — three quick questions in your workbench. The first two check themselves; the last one I'll grade myself.`;

const quizIntroDeltas = messageDeltas('item-quiz-intro', QUIZ_INTRO_TEXT, 900, 55);

export const quizTurnScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  ...quizIntroDeltas,
  { at: lastAt(quizIntroDeltas) + 200, event: { type: 'workbench.quiz', quiz: QUIZ_PAYLOAD } },
  {
    at: lastAt(quizIntroDeltas) + 500,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

const QUIZ_GRADED_TEXT = `Your short answer nails the mechanism: the ON clause decides what *matches*, the WHERE clause decides what *survives*. I'd only add: this is why the filter's placement is a semantic choice, not a style one.`;

const quizGradedDeltas = messageDeltas('item-quiz-graded', QUIZ_GRADED_TEXT, 2100, 55);

export const quizGradedTurnScript: ReplayStep[] = [
  { at: 200, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 450,
    event: { type: 'activity', kind: 'tool', label: 'grading your answers', status: 'started' },
  },
  {
    at: 1800,
    event: { type: 'activity', kind: 'tool', label: 'grading your answers', status: 'completed' },
  },
  ...quizGradedDeltas,
  {
    at: lastAt(quizGradedDeltas) + 200,
    event: {
      type: 'quiz.graded',
      quizId: 'quiz-007',
      results: [
        {
          question_id: 'q1',
          verdict: 'correct',
          feedback_md: 'The WHERE filter drops the NULL rows the LEFT JOIN preserved.',
        },
        {
          question_id: 'q2',
          verdict: 'correct',
          feedback_md: '2 matched rows + 3 unmatched customers = 5.',
        },
        {
          question_id: 'q3',
          verdict: 'partial',
          feedback_md:
            'Right mechanism — ON controls matching, WHERE controls survival. One refinement: unmatched left rows carry NULLs, so almost any WHERE comparison on the right table silently drops them.',
        },
      ],
    },
  },
  {
    at: lastAt(quizGradedDeltas) + 700,
    event: {
      type: 'assessment.recorded',
      concept_deltas: [
        {
          topic: 'sql',
          concept: 'inner-join',
          from: 0.72,
          to: 0.78,
          evidence: 'quiz-007: identified the WHERE-collapse to INNER JOIN instantly',
        },
      ],
    },
  },
  {
    at: lastAt(quizGradedDeltas) + 1000,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
  },
];

export const ARTIFACT_PAYLOAD: ArtifactPayload = {
  id: 'artifact-003',
  title: 'ON vs WHERE — watch the rows survive',
  html: `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { margin: 0; padding: 20px; background: #0B0D12; color: #E8EAF0;
         font: 14px/1.6 ui-monospace, 'JetBrains Mono', Menlo, monospace; }
  h1 { font-size: 15px; margin: 0 0 4px; color: #E8EAF0; }
  p  { margin: 0 0 16px; color: #8B93A7; font-size: 13px; }
  .toggle { display: inline-flex; border: 1px solid #252A37; border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
  .toggle button { background: #12151D; color: #8B93A7; border: 0; padding: 8px 14px; font: inherit; cursor: pointer; }
  .toggle button.on { background: #7C6AEF33; color: #B9AFFF; }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #252A37; padding: 6px 10px; text-align: left; font-size: 13px; }
  th { color: #8B93A7; font-weight: 500; background: #12151D; }
  tr.dropped td { color: #4A4F5E; text-decoration: line-through; background: #F851490D; }
  tr.kept td.null { color: #F5A623; }
  .count { margin-top: 12px; font-size: 13px; color: #3ECF8E; }
</style>
</head>
<body>
  <h1>LEFT JOIN customers → orders (total &gt; 100)</h1>
  <p>Same query, one difference: where the filter lives.</p>
  <div class="toggle" role="group">
    <button id="on" class="on">filter in ON</button>
    <button id="where">filter in WHERE</button>
  </div>
  <table id="t">
    <thead><tr><th>name</th><th>total</th></tr></thead>
    <tbody>
      <tr><td>Ada</td><td>250</td></tr>
      <tr><td>Bo</td><td>180</td></tr>
      <tr data-null="1"><td>Chi</td><td class="null">NULL</td></tr>
      <tr data-null="1"><td>Dana</td><td class="null">NULL</td></tr>
    </tbody>
  </table>
  <p class="count" id="count"></p>
  <script>
    var onBtn = document.getElementById('on'), whereBtn = document.getElementById('where');
    function render(mode) {
      onBtn.className = mode === 'on' ? 'on' : '';
      whereBtn.className = mode === 'where' ? 'on' : '';
      var rows = document.querySelectorAll('#t tbody tr'), kept = 0;
      rows.forEach(function (tr) {
        var dropped = mode === 'where' && tr.dataset.null;
        tr.className = dropped ? 'dropped' : 'kept';
        if (!dropped) kept++;
      });
      document.getElementById('count').textContent =
        mode === 'on'
          ? kept + ' rows — orderless customers kept, totals NULL'
          : kept + ' rows — the WHERE filter silently dropped the NULL rows';
    }
    onBtn.onclick = function () { render('on'); };
    whereBtn.onclick = function () { render('where'); };
    render('on');
  </script>
</body>
</html>`,
};

const ARTIFACT_INTRO_TEXT = `Here — sometimes you have to *see* the rows disappear. Toggle the filter position in the artifact and watch what happens to Chi and Dana.`;

const artifactIntroDeltas = messageDeltas('item-artifact-intro', ARTIFACT_INTRO_TEXT, 900, 55);

export const artifactTurnScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-preview-thread' } },
  {
    at: 250,
    event: { type: 'activity', kind: 'tool', label: 'building a visual', status: 'started' },
  },
  {
    at: 700,
    event: { type: 'activity', kind: 'tool', label: 'building a visual', status: 'completed' },
  },
  ...artifactIntroDeltas,
  {
    at: lastAt(artifactIntroDeltas) + 200,
    event: { type: 'workbench.artifact', artifact: ARTIFACT_PAYLOAD },
  },
  {
    at: lastAt(artifactIntroDeltas) + 500,
    event: { type: 'turn.completed', threadId: 'dev-preview-thread' },
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

const ONBOARDING_BASELINE = `That gives me a picture — let's calibrate it. A tiny baseline check just appeared: three quick questions, zero stakes. Answer what you can; guessing is useful data too.`;

const ONBOARDING_FINALE = `Perfect — I know enough to start. Writing your profile now; you can watch me do it.`;

/** Baseline quiz for the onboarding preview — answered inside the wizard. */
export const ONBOARDING_QUIZ_PAYLOAD: QuizPayload = {
  id: 'quiz-ob-001',
  concepts: ['inner-join', 'group-by'],
  questions: [
    {
      id: 'ob-q1',
      type: 'mcq',
      prompt_md: 'An `INNER JOIN` between `customers` and `orders` returns…',
      options: [
        'Every customer, with NULLs where no order matches',
        'Only the customer–order pairs that match the join condition',
        'Every combination of customer and order',
        'Only customers without orders',
      ],
      answer: 'Only the customer–order pairs that match the join condition',
    },
    {
      id: 'ob-q2',
      type: 'predict_output',
      prompt_md: `\`orders\` has 3 rows with totals 40, 90, and 120. What single number does this return?

\`\`\`sql
SELECT count(*) FROM orders WHERE total > 50;
\`\`\``,
      answer: '2',
    },
    {
      id: 'ob-q3',
      type: 'short',
      prompt_md: 'In one line: when would you reach for `GROUP BY`?',
    },
  ],
};

const ONBOARDING_GRADED_TEXT = `Nice — that's exactly the calibration I needed. Joins look solid; aggregation is where we'll start. Writing your profile now; you can watch me do it.`;

/**
 * Replayed when the preview learner finishes the baseline quiz: grade →
 * profile write → the birth commit (the finale takes over from there).
 */
export const onboardingQuizGradedScript: ReplayStep[] = [
  { at: 100, event: { type: 'turn.started', threadId: 'dev-onboarding-thread' } },
  {
    at: 400,
    event: { type: 'activity', kind: 'tool', label: 'grading your answers', status: 'started' },
  },
  {
    at: 1300,
    event: { type: 'activity', kind: 'tool', label: 'grading your answers', status: 'completed' },
  },
  {
    at: 1500,
    event: {
      type: 'quiz.graded',
      quizId: 'quiz-ob-001',
      results: [
        {
          question_id: 'ob-q3',
          verdict: 'partial',
          feedback_md:
            'Right instinct — collapsing rows into groups. The refinement: `GROUP BY` is for one row *per group*; running totals need a window function.',
        },
      ],
    },
  },
  ...messageDeltas('item-ob-graded', ONBOARDING_GRADED_TEXT, 2000, 50),
  {
    at: 5200,
    event: { type: 'activity', kind: 'tool', label: 'writing your profile', status: 'started' },
  },
  {
    at: 6300,
    event: { type: 'activity', kind: 'tool', label: 'writing your profile', status: 'completed' },
  },
  { at: 6600, event: { type: 'memory.commit', commit: ONBOARDING_COMMIT } },
  { at: 6900, event: { type: 'turn.completed', threadId: 'dev-onboarding-thread' } },
];

export const onboardingGreetingScript: ReplayStep[] = [
  { at: 0, event: { type: 'turn.started', threadId: 'dev-onboarding-thread' } },
  {
    at: 400,
    event: { type: 'reasoning.delta', text: 'Fresh workspace — starting the interview…' },
  },
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

/** Consumed one per user send: Background → Baseline (quiz push) → profile
 * commit (the chat-skip path; finishing the quiz instead replays
 * onboardingQuizGradedScript). */
export const onboardingReplyScripts: ReplayStep[][] = [
  onboardingReply('item-ob-background', ONBOARDING_BACKGROUND),
  onboardingReply('item-ob-baseline', ONBOARDING_BASELINE, [
    { at: 300, event: { type: 'workbench.quiz', quiz: ONBOARDING_QUIZ_PAYLOAD } },
  ]),
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
