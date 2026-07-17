import type { QuizQuestion, SubmitQuizRequest } from '@eduagent/shared';

/**
 * Workbench pure helpers (plans/04 §3): client-side quiz checking for
 * mcq/predict_output (the answer key ships in the payload — accepted team
 * decision, mcp-tools.ts), per-exercise editor persistence, and the per-thread
 * collapsed-state key. Storage is injected so the logic is testable without a
 * DOM; the default is a guarded window.localStorage (private-mode safe).
 */

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): KeyValueStore | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function safeGet(key: string, store: KeyValueStore | null): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string, store: KeyValueStore | null): void {
  try {
    store?.setItem(key, value);
  } catch {
    // quota / private mode — persistence is best-effort, never fatal
  }
}

// ---------------------------------------------------------------------------
// Exercise editor persistence — refresh never loses code (plans/04 §2)
// ---------------------------------------------------------------------------

export function exerciseCodeKey(exerciseId: string): string {
  return `eduagent:exercise-code:${exerciseId}`;
}

export function loadExerciseCode(
  exerciseId: string,
  store: KeyValueStore | null = defaultStore(),
): string | null {
  return safeGet(exerciseCodeKey(exerciseId), store);
}

export function saveExerciseCode(
  exerciseId: string,
  code: string,
  store: KeyValueStore | null = defaultStore(),
): void {
  safeSet(exerciseCodeKey(exerciseId), code, store);
}

// ---------------------------------------------------------------------------
// Workbench open/collapsed state — persists per thread (plans/04 §3)
// ---------------------------------------------------------------------------

export function workbenchOpenKey(threadId: string): string {
  return `eduagent:workbench-open:${threadId}`;
}

/** null = no stored preference (caller picks the default). */
export function loadWorkbenchOpen(
  threadId: string,
  store: KeyValueStore | null = defaultStore(),
): boolean | null {
  const raw = safeGet(workbenchOpenKey(threadId), store);
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

export function saveWorkbenchOpen(
  threadId: string,
  open: boolean,
  store: KeyValueStore | null = defaultStore(),
): void {
  safeSet(workbenchOpenKey(threadId), String(open), store);
}

// ---------------------------------------------------------------------------
// Client-side quiz checking (plans/04 §3)
// ---------------------------------------------------------------------------

export type ClientVerdict = 'correct' | 'incorrect';

/**
 * predict_output comparison: line-based, whitespace-collapsed, case-insensitive
 * — "5 rows" should match "5  ROWS", but "5\n6" must not match "56".
 */
export function normalizePredictedOutput(text: string): string {
  const lines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '));
  while (lines.length > 0 && lines[0] === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n').toLowerCase();
}

/**
 * Instant client-side verdict for mcq/predict_output; null means the question
 * is agent-graded (short answers, or a payload missing its key).
 */
export function checkAnswer(question: QuizQuestion, answer: string): ClientVerdict | null {
  if (question.type === 'short' || !question.answer) return null;
  if (question.type === 'mcq') {
    return answer.trim() === question.answer.trim() ? 'correct' : 'incorrect';
  }
  return normalizePredictedOutput(answer) === normalizePredictedOutput(question.answer)
    ? 'correct'
    : 'incorrect';
}

/**
 * The POST /api/quiz/:id/submit body (shared submitQuizRequestSchema): every
 * answer ships; client-checked questions carry their verdict as mastery
 * evidence, short answers carry none (the agent grades them).
 */
export function buildQuizSubmission(
  questions: QuizQuestion[],
  answers: Record<string, string>,
): SubmitQuizRequest['answers'] {
  return questions.map((question) => {
    const answer = answers[question.id] ?? '';
    const verdict = checkAnswer(question, answer);
    return { question_id: question.id, answer, ...(verdict ? { verdict } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Monaco language ids from exercise payload `language` strings
// ---------------------------------------------------------------------------

const MONACO_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'shell',
  bash: 'shell',
  'c++': 'cpp',
  golang: 'go',
};

export function monacoLanguage(language: string): string {
  const lower = language.toLowerCase();
  return MONACO_LANGUAGE_ALIASES[lower] ?? lower;
}
