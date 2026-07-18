import type { Prisma } from '@prisma/client';
import {
  examAnswersSchema,
  examQuestionsSchema,
  examResultSchema,
  type ExamAnswers,
  type ExamQuestions,
  type ExamResult,
} from '@eduagent/shared';
import type { ExamConfig } from '../learning/exam-config.js';

/**
 * The canonical content of Alex's seeded mock exam (plans/02 §7). ONE source
 * for two artifacts that must never diverge:
 *
 * - the workspace record `exams/<date>-sql-interview-mock.md` (written by
 *   alex.ts, committed as the exam commit two days back), and
 * - the graded Exam DB row (`buildAlexExamRow`) that puts the same sitting in
 *   /app/exam History with a full read-only results view.
 *
 * The DB row carries NO threadId: codex threads cannot be fabricated offline
 * (see seed.ts), and a graded exam is terminal — nothing ever resumes or
 * forks it, so the row renders results entirely from its own JSON.
 */

export const ALEX_EXAM_ID = 'alex-mock-exam-1';
export const ALEX_EXAM_TRACK = 'sql-interview';
export const ALEX_EXAM_DURATION_MIN = 60;

export interface AlexExamQuestionSpec {
  id: string;
  kind: 'coding' | 'mcq' | 'short';
  concept: string;
  /** One-line summary rendered in the workspace exam record. */
  gist: string;
  verdict: 'correct' | 'partial' | 'incorrect';
  pointsAwarded: number;
  points: number;
  /** Grader aside rendered in the record (italic); also woven into feedback. */
  note?: string;
  prompt: string;
  options?: string[];
  language?: string;
  starterCode?: string;
  /** The answer Alex submitted, exactly as graded. */
  answer: string;
  feedback: string;
}

export const ALEX_EXAM_QUESTIONS: AlexExamQuestionSpec[] = [
  {
    id: 'q1',
    kind: 'coding',
    concept: 'inner-join',
    gist: 'Revenue per customer via INNER JOIN + GROUP BY',
    verdict: 'correct',
    pointsAwarded: 18,
    points: 18,
    prompt: [
      'Given `customers(id, name)` and `orders(id, customer_id, amount)`, write a query',
      'returning each customer who has placed at least one order, with their total',
      'order revenue, highest first.',
    ].join('\n'),
    language: 'sql',
    starterCode: '-- customers(id, name), orders(id, customer_id, amount)\nSELECT\n',
    answer: [
      'SELECT c.name, SUM(o.amount) AS revenue',
      'FROM customers c',
      'JOIN orders o ON o.customer_id = c.id',
      'GROUP BY c.id, c.name',
      'ORDER BY revenue DESC;',
    ].join('\n'),
    feedback: [
      'Clean and correct. The INNER JOIN drops order-less customers exactly as asked,',
      'grouping by `c.id` (not just the name) survives duplicate names, and the sort',
      'direction matches the spec. This is interview-ready.',
    ].join('\n'),
  },
  {
    id: 'q2',
    kind: 'coding',
    concept: 'left-join',
    gist: 'Customers with zero orders (LEFT JOIN … IS NULL)',
    verdict: 'partial',
    pointsAwarded: 10,
    points: 18,
    note: 'COUNT counted NULL-extended rows',
    prompt: [
      'Using the same schema, list every customer with **zero** orders, together with',
      'an order count column (which should read 0 for all of them).',
    ].join('\n'),
    language: 'sql',
    starterCode: '-- customers(id, name), orders(id, customer_id, amount)\nSELECT\n',
    answer: [
      'SELECT c.name, COUNT(*) AS order_count',
      'FROM customers c',
      'LEFT JOIN orders o ON o.customer_id = c.id',
      'WHERE o.id IS NULL',
      'GROUP BY c.id, c.name;',
    ].join('\n'),
    feedback: [
      'The LEFT JOIN … IS NULL filter is right, so the customer set is correct — but',
      '`COUNT(*)` counts the NULL-extended row itself, so every count reads 1, not 0.',
      '`COUNT(o.id)` skips NULLs and reads 0. This is the exact COUNT(*) vs COUNT(col)',
      'distinction from your review queue — worth one more rep.',
    ].join('\n'),
  },
  {
    id: 'q3',
    kind: 'mcq',
    concept: 'where-clause',
    gist: 'Predicate evaluation order',
    verdict: 'correct',
    pointsAwarded: 8,
    points: 8,
    prompt:
      'In a query with a JOIN and a WHERE clause, when is the WHERE predicate logically applied?',
    options: [
      'Before the JOIN, to each table separately',
      'After the JOIN, to the joined rows',
      'Interleaved with the JOIN, row by row',
      'Only when an index exists on the predicate column',
    ],
    answer: 'After the JOIN, to the joined rows',
    feedback:
      'Right — WHERE filters the joined result. The optimizer may push predicates down, but the logical model (and the results) are join-then-filter. The misconception you opened in week one is resolved and holding.',
  },
  {
    id: 'q4',
    kind: 'mcq',
    concept: 'union-set-ops',
    gist: 'UNION vs UNION ALL row counts',
    verdict: 'incorrect',
    pointsAwarded: 0,
    points: 8,
    note: 'predicted duplicates survive UNION',
    prompt: [
      'Query A returns 4 rows, query B returns 3 rows, and exactly 2 rows appear in',
      'both results. How many rows do `A UNION B` and `A UNION ALL B` return?',
    ].join('\n'),
    options: [
      'UNION: 7, UNION ALL: 7',
      'UNION: 5, UNION ALL: 7',
      'UNION: 7, UNION ALL: 5',
      'UNION: 5, UNION ALL: 5',
    ],
    answer: 'UNION: 7, UNION ALL: 7',
    feedback: [
      'UNION deduplicates: 4 + 3 − 2 = **5** distinct rows, while UNION ALL keeps all',
      '**7**. You predicted duplicates survive plain UNION — logged as a new',
      'misconception with a remediation drill queued.',
    ].join('\n'),
  },
  {
    id: 'q5',
    kind: 'mcq',
    concept: 'aggregates',
    gist: 'COUNT(*) vs COUNT(col) with NULLs',
    verdict: 'correct',
    pointsAwarded: 8,
    points: 8,
    prompt:
      'A table has 10 rows and its `email` column is NULL in 4 of them. What do `COUNT(*)` and `COUNT(email)` return?',
    options: [
      'COUNT(*): 10, COUNT(email): 10',
      'COUNT(*): 10, COUNT(email): 6',
      'COUNT(*): 6, COUNT(email): 6',
      'COUNT(*): 6, COUNT(email): 10',
    ],
    answer: 'COUNT(*): 10, COUNT(email): 6',
    feedback:
      'Correct — COUNT(*) counts rows, COUNT(col) skips NULLs. Interesting that this held in isolation while q2 missed the same rule inside a LEFT JOIN; the review drill targets that transfer.',
  },
  {
    id: 'q6',
    kind: 'mcq',
    concept: 'subqueries',
    gist: 'Correlated subquery evaluation',
    verdict: 'correct',
    pointsAwarded: 8,
    points: 8,
    prompt:
      'What makes a subquery *correlated*, and how often is it logically evaluated?',
    options: [
      'It references the outer query; logically once per outer row',
      'It references the outer query; evaluated exactly once',
      'It appears in FROM; evaluated once per transaction',
      'It uses IN; evaluated once per distinct value',
    ],
    answer: 'It references the outer query; logically once per outer row',
    feedback:
      'Exactly — the outer-row reference is what correlates it, and the logical model is once per outer row (engines may decorrelate under the hood).',
  },
  {
    id: 'q7',
    kind: 'short',
    concept: 'null-semantics',
    gist: 'Explain NULL = NULL in WHERE',
    verdict: 'partial',
    pointsAwarded: 9,
    points: 16,
    note: 'missed the three-valued logic framing',
    prompt:
      'A colleague writes `WHERE deleted_at = NULL` and gets zero rows. Explain what happens and give the correct predicate.',
    answer:
      'NULL means unknown, so comparing anything to NULL with = never matches. You have to use IS NULL instead: WHERE deleted_at IS NULL.',
    feedback: [
      'The fix is right and "unknown" is the right instinct. What is missing is the',
      'mechanism: `= NULL` evaluates to **UNKNOWN** (not FALSE) under SQL three-valued',
      'logic, and WHERE only keeps rows where the predicate is TRUE. That framing also',
      'explains NOT IN with NULLs — queued for the next session.',
    ].join('\n'),
  },
  {
    id: 'q8',
    kind: 'short',
    concept: 'group-by',
    gist: 'Choose the grouping grain for a report',
    verdict: 'partial',
    pointsAwarded: 10,
    points: 16,
    note: 'grain right, justification thin',
    prompt: [
      'Product wants "monthly revenue per region, with each region\'s share of that',
      "month's total\". What do you GROUP BY, and where does the share calculation live?",
    ].join('\n'),
    answer:
      'GROUP BY month and region to get revenue per region per month. Then divide by the month total — probably a window function like SUM(revenue) OVER (PARTITION BY month).',
    feedback: [
      'Grain is right (month × region) and reaching for a window function over the',
      'grouped result is the clean pattern. For full credit, justify the grain: the',
      'finest grain any requested number needs, so shares divide a region row by its',
      "month's partition total without regrouping.",
    ].join('\n'),
  },
];

/** Sections as the exam room would render them, built from the flat spec. */
function buildQuestions(): ExamQuestions {
  const byKind = (kind: AlexExamQuestionSpec['kind']) =>
    ALEX_EXAM_QUESTIONS.filter((q) => q.kind === kind).map((q) => ({
      id: q.id,
      type: q.kind,
      prompt_md: q.prompt,
      concepts: [q.concept],
      points: q.points,
      ...(q.options ? { options: q.options } : {}),
      ...(q.language ? { language: q.language } : {}),
      ...(q.starterCode ? { starter_code: q.starterCode } : {}),
    }));
  return examQuestionsSchema.parse({
    track: ALEX_EXAM_TRACK,
    duration_min: ALEX_EXAM_DURATION_MIN,
    sections: [
      { title: 'Coding', questions: byKind('coding') },
      { title: 'Multiple choice', questions: byKind('mcq') },
      { title: 'Short answer', questions: byKind('short') },
    ],
  });
}

export interface AlexExamRowOptions {
  userId: string;
  /** Track readiness (0–100, 1dp) before/after grading — the seeder's own numbers. */
  before: number;
  after: number;
  /** The exam commit instant: grading lands the moment the commit does. */
  gradedAt: Date;
  /** Bottom-weakest targeting at creation, from the generator's pre-exam state. */
  targeting: ExamConfig['targeting'];
}

/**
 * The graded Exam row mirroring the workspace record. Timestamps walk
 * backwards from the exam commit: a full 60m sitting submitted just before
 * grading landed. All JSON re-parses through the shared schemas so seed
 * content can never drift out of contract.
 */
export function buildAlexExamRow(opts: AlexExamRowOptions): Prisma.ExamUncheckedCreateInput {
  const questions = buildQuestions();
  const answers: ExamAnswers = examAnswersSchema.parse(
    Object.fromEntries(ALEX_EXAM_QUESTIONS.map((q) => [q.id, q.answer])),
  );
  const total = ALEX_EXAM_QUESTIONS.reduce((sum, q) => sum + q.pointsAwarded, 0);
  const result: ExamResult = examResultSchema.parse({
    per_question: ALEX_EXAM_QUESTIONS.map((q) => ({
      id: q.id,
      verdict: q.verdict,
      points_awarded: q.pointsAwarded,
      feedback_md: q.feedback,
    })),
    total,
    readiness_delta: round1(opts.after - opts.before),
    readiness_before: opts.before,
    readiness_after: opts.after,
  });
  const config: ExamConfig = {
    durationMin: ALEX_EXAM_DURATION_MIN,
    targeting: opts.targeting,
    readinessBefore: opts.before,
  };

  const gradedAt = opts.gradedAt;
  const submittedAt = new Date(gradedAt.getTime() - 3 * 60_000);
  const startedAt = new Date(submittedAt.getTime() - ALEX_EXAM_DURATION_MIN * 60_000);
  const createdAt = new Date(startedAt.getTime() - 4 * 60_000);

  return {
    id: ALEX_EXAM_ID,
    userId: opts.userId,
    threadId: null,
    trackSlug: ALEX_EXAM_TRACK,
    config: config as Prisma.InputJsonValue,
    questions: questions as Prisma.InputJsonValue,
    answers: answers as Prisma.InputJsonValue,
    result: result as Prisma.InputJsonValue,
    status: 'graded',
    startedAt,
    submittedAt,
    gradedAt,
    createdAt,
  };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
