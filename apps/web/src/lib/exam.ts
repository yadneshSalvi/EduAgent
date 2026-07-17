import type {
  ExamAnswers,
  ExamDto,
  ExamQuestion,
  ExamQuestions,
  ExamResult,
  ExamStatus,
  TimelineEntry,
} from '@eduagent/shared';
import type { KeyValueStore } from './workbench';

/**
 * Exam pure helpers (plans/04 §6): server-authoritative deadline math, the
 * question palette derivation, autosave scheduling, and the results-view
 * mapping. All pure and injected so vitest covers them without a DOM or a
 * clock.
 */

// ---------------------------------------------------------------------------
// Deadline math — the timer counts down to startedAt + durationMin, exactly.
// The server's 30s enforcement grace is never displayed (plans/03 §3.5).
// ---------------------------------------------------------------------------

export function examDeadlineMs(startedAt: string, durationMin: number): number {
  return new Date(startedAt).getTime() + durationMin * 60_000;
}

/** Milliseconds left on the clock, floored at zero. */
export function msRemaining(deadlineMs: number, nowMs: number): number {
  return Math.max(0, deadlineMs - nowMs);
}

/** `42:17` under an hour, `1:02:07` above it. Ceils so 0:00 means expired. */
export function formatClock(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

export type TimerTone = 'calm' | 'amber' | 'red';

/** Calm → amber under 5 minutes → red under 1 minute (plans/04 task spec). */
export function timerTone(ms: number): TimerTone {
  if (ms < 60_000) return 'red';
  if (ms < 300_000) return 'amber';
  return 'calm';
}

// ---------------------------------------------------------------------------
// Question flattening & palette derivation
// ---------------------------------------------------------------------------

export interface FlatQuestion {
  question: ExamQuestion;
  /** 1-based, continuous across sections. */
  number: number;
  sectionIndex: number;
  sectionTitle: string;
}

export function flattenQuestions(questions: ExamQuestions): FlatQuestion[] {
  const flat: FlatQuestion[] = [];
  questions.sections.forEach((section, sectionIndex) => {
    for (const question of section.questions) {
      flat.push({
        question,
        number: flat.length + 1,
        sectionIndex,
        sectionTitle: section.title,
      });
    }
  });
  return flat;
}

export function totalPoints(questions: ExamQuestions): number {
  return questions.sections.reduce(
    (sum, section) => sum + section.questions.reduce((s, q) => s + q.points, 0),
    0,
  );
}

export function isAnswered(answers: ExamAnswers, questionId: string): boolean {
  return (answers[questionId] ?? '').trim() !== '';
}

export function unansweredCount(flat: FlatQuestion[], answers: ExamAnswers): number {
  return flat.filter((entry) => !isAnswered(answers, entry.question.id)).length;
}

export interface PaletteItem {
  id: string;
  number: number;
  answered: boolean;
  flagged: boolean;
}

export function buildPalette(
  flat: FlatQuestion[],
  answers: ExamAnswers,
  flags: ReadonlySet<string>,
): PaletteItem[] {
  return flat.map(({ question, number }) => ({
    id: question.id,
    number,
    answered: isAnswered(answers, question.id),
    flagged: flags.has(question.id),
  }));
}

// ---------------------------------------------------------------------------
// Autosave scheduling — a ~15s heartbeat plus a short debounce after typing,
// evaluated by a 1s ticker (PUT /api/exams/:id/answers, plans/03 §7).
// ---------------------------------------------------------------------------

export const AUTOSAVE_INTERVAL_MS = 15_000;
export const AUTOSAVE_DEBOUNCE_MS = 2_500;

export interface AutosaveClock {
  /** Timestamp of the first unsaved change; null when everything is saved. */
  dirtySince: number | null;
  lastSaveAt: number;
}

/**
 * A save is due when there are unsaved changes AND either the debounce window
 * since the first unsaved change elapsed or the heartbeat since the last save
 * elapsed — whichever comes first.
 */
export function autosaveDue(
  clock: AutosaveClock,
  nowMs: number,
  intervalMs: number = AUTOSAVE_INTERVAL_MS,
  debounceMs: number = AUTOSAVE_DEBOUNCE_MS,
): boolean {
  if (clock.dirtySince === null) return false;
  return nowMs - clock.dirtySince >= debounceMs || nowMs - clock.lastSaveAt >= intervalMs;
}

// ---------------------------------------------------------------------------
// Local persistence — refresh never loses answers (plans/04 §2). The server's
// last autosave is the base; local (saved on every keystroke) wins per key.
// ---------------------------------------------------------------------------

function defaultStore(): KeyValueStore | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function examAnswersKey(examId: string): string {
  return `eduagent:exam-answers:${examId}`;
}

export function examFlagsKey(examId: string): string {
  return `eduagent:exam-flags:${examId}`;
}

export function loadExamAnswers(
  examId: string,
  store: KeyValueStore | null = defaultStore(),
): ExamAnswers | null {
  try {
    const raw = store?.getItem(examAnswersKey(examId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const answers: ExamAnswers = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') answers[key] = value;
    }
    return answers;
  } catch {
    return null;
  }
}

export function saveExamAnswersLocal(
  examId: string,
  answers: ExamAnswers,
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(examAnswersKey(examId), JSON.stringify(answers));
  } catch {
    // quota / private mode — persistence is best-effort, never fatal
  }
}

export function loadExamFlags(
  examId: string,
  store: KeyValueStore | null = defaultStore(),
): string[] {
  try {
    const raw = store?.getItem(examFlagsKey(examId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function saveExamFlags(
  examId: string,
  flags: ReadonlySet<string>,
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.setItem(examFlagsKey(examId), JSON.stringify([...flags]));
  } catch {
    // best-effort
  }
}

/** Graded exams no longer need drafts — clear the sitting's local state. */
export function clearExamLocal(
  examId: string,
  store: KeyValueStore | null = defaultStore(),
): void {
  try {
    store?.removeItem(examAnswersKey(examId));
    store?.removeItem(examFlagsKey(examId));
  } catch {
    // best-effort
  }
}

/** Server autosave as the base, local draft (newer by construction) on top. */
export function mergeAnswers(
  server: ExamAnswers | null,
  local: ExamAnswers | null,
): ExamAnswers {
  return { ...(server ?? {}), ...(local ?? {}) };
}

// ---------------------------------------------------------------------------
// Results mapping (plans/04 §6): grades joined to questions, per-concept
// aggregation, and the readiness sweep values for the gauge.
// ---------------------------------------------------------------------------

export interface QuestionResultView extends FlatQuestion {
  grade: ExamResult['per_question'][number] | null;
  answer: string;
}

export function buildQuestionResults(
  questions: ExamQuestions,
  result: ExamResult,
  answers: ExamAnswers | null,
): QuestionResultView[] {
  const grades = new Map(result.per_question.map((grade) => [grade.id, grade]));
  return flattenQuestions(questions).map((entry) => ({
    ...entry,
    grade: grades.get(entry.question.id) ?? null,
    answer: answers?.[entry.question.id] ?? '',
  }));
}

export interface ConceptResult {
  concept: string;
  points: number;
  pointsAwarded: number;
  correct: number;
  partial: number;
  incorrect: number;
}

export type ConceptOutcome = 'held' | 'mixed' | 'slipped';

export function conceptOutcome(entry: ConceptResult): ConceptOutcome {
  if (entry.incorrect === 0 && entry.partial === 0) return 'held';
  if (entry.correct === 0 && entry.partial === 0) return 'slipped';
  return 'mixed';
}

/** Aggregates graded points per concept, in first-appearance order. */
export function buildConceptResults(questionResults: QuestionResultView[]): ConceptResult[] {
  const byConcept = new Map<string, ConceptResult>();
  for (const entry of questionResults) {
    if (entry.grade === null) continue;
    for (const concept of entry.question.concepts) {
      const existing = byConcept.get(concept) ?? {
        concept,
        points: 0,
        pointsAwarded: 0,
        correct: 0,
        partial: 0,
        incorrect: 0,
      };
      existing.points += entry.question.points;
      existing.pointsAwarded += entry.grade.points_awarded;
      existing[entry.grade.verdict] += 1;
      byConcept.set(concept, existing);
    }
  }
  return [...byConcept.values()];
}

export interface ReadinessSweep {
  /** null when the server snapshot is missing — render the delta pill only. */
  before: number | null;
  after: number | null;
  delta: number;
}

/**
 * Prefers the server-computed exact snapshot (readiness_before/after); when
 * only one side survived, derives the other from the delta so the gauge can
 * still sweep. delta always renders as round1(after − before) when both exist.
 */
export function readinessSweep(result: ExamResult): ReadinessSweep {
  const { readiness_before: before, readiness_after: after, readiness_delta: delta } = result;
  if (before !== undefined && after !== undefined) {
    return { before, after, delta: round1(after - before) };
  }
  if (after !== undefined) return { before: clampScore(after - delta), after, delta };
  if (before !== undefined) return { before, after: clampScore(before + delta), delta };
  return { before: null, after: null, delta };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, round1(value)));
}

/**
 * Poll cadence for GET /api/exams/:id (WS is the fast path; polling is the
 * sanctioned fallback, plans/03 §3.5): fast while a server-side turn is
 * running (draft = generating, submitted = grading) and while an expired
 * in_progress exam waits for the sweep to auto-submit it. Off otherwise.
 */
export function pollIntervalMs(
  exam: Pick<ExamDto, 'status' | 'startedAt' | 'durationMin'> | undefined,
  nowMs: number,
): number | false {
  if (!exam) return false;
  if (exam.status === 'draft' || exam.status === 'submitted') return 2500;
  if (
    exam.status === 'in_progress' &&
    exam.startedAt !== null &&
    nowMs >= examDeadlineMs(exam.startedAt, exam.durationMin)
  ) {
    return 3000;
  }
  return false;
}

/**
 * The grading commit for this sitting in a newest-first memory log: the most
 * recent `exam` commit dated at/after submission (60s slack for clock skew).
 * -1 when it hasn't landed yet.
 */
export function findExamCommitIndex(
  commits: TimelineEntry[],
  submittedAt: string | null,
): number {
  const floor = submittedAt === null ? null : new Date(submittedAt).getTime() - 60_000;
  return commits.findIndex(
    (entry) =>
      entry.type === 'exam' && (floor === null || new Date(entry.date).getTime() >= floor),
  );
}

// ---------------------------------------------------------------------------
// Status labels for the history list
// ---------------------------------------------------------------------------

export const EXAM_STATUS_LABEL: Record<ExamStatus, string> = {
  draft: 'generating',
  ready: 'ready',
  in_progress: 'in progress',
  submitted: 'grading',
  graded: 'graded',
};
