/**
 * The `Exam.config` payload + deadline math (plans/03 §3.5, plans/02 §5).
 * Split from ExamService so ThreadManager can rebuild exam-thread
 * developerInstructions from a bare Exam row (instruction rotation happens on
 * thread/resume) without importing the service layer.
 *
 * Like every SQLite Json column, `config` is written whole by the server and
 * zod-parsed on read — the schema below is its single shape.
 */
import { z } from 'zod';

/** One server-computed targeting entry (DashboardData readiness `weakest`). */
export const examTargetSchema = z.object({
  /** Bare concept id within the track, e.g. "window-functions". */
  concept: z.string().min(1),
  /** Display name, e.g. "Window functions". */
  name: z.string().min(1),
  /** Effective (decayed) mastery 0..1 at exam creation. */
  effective: z.number().min(0).max(1),
});
export type ExamTarget = z.infer<typeof examTargetSchema>;

export const examConfigSchema = z.object({
  durationMin: z.number().int().positive(),
  /**
   * The bottom-5 weighted concepts for the track at creation time — the list
   * exam generation attacks (plans/02 §4) and the generation instructions
   * embed. Stored so instruction rebuilds (thread/resume) stay deterministic.
   */
  targeting: z.array(examTargetSchema),
  /**
   * Track readiness (0–100) computed at submit time, before any grading
   * mastery updates — the "before" of the exact result snapshot.
   */
  readinessBefore: z.number().min(0).max(100).optional(),
});
export type ExamConfig = z.infer<typeof examConfigSchema>;

/** Parses `Exam.config`; throws on corruption (the server is the only writer). */
export function parseExamConfig(config: unknown): ExamConfig {
  return examConfigSchema.parse(config);
}

/**
 * Autosave/submit tolerance past the deadline (plans/03 §3.5: the deadline is
 * `startedAt + durationMin` and the server adds a 30s grace on enforcement).
 */
export const EXAM_GRACE_MS = 30_000;

/** The client-facing deadline: startedAt + durationMin (no grace). */
export function examDeadline(startedAt: Date, durationMin: number): Date {
  return new Date(startedAt.getTime() + durationMin * 60_000);
}

/** True once even the grace window is spent — autosaves reject, the sweep submits. */
export function examExpired(startedAt: Date, durationMin: number, now: Date): boolean {
  return now.getTime() > examDeadline(startedAt, durationMin).getTime() + EXAM_GRACE_MS;
}

/** Workspace-relative exam workdir for one coding question (gitignored until grading). */
export function examWorkdir(examId: string, questionId: string): string {
  return `.exercises/exam-${examId}-${questionId}`;
}

/** Workspace-relative answer-key dir (same gitignored `exam-*` namespace). */
export function examKeyDir(examId: string): string {
  return `.exercises/exam-${examId}-key`;
}

/**
 * The gitignore pattern that keeps exam workdirs (hidden tests, answer key,
 * submissions) out of git until the grading turn force-adds them — committed
 * git objects are learner-readable via the memory explorer mid-exam
 * (plans/06 Phase 4 task 5). Present in the workspace template's .gitignore;
 * ExamService also pins it into `.git/info/exclude` for workspaces born
 * before Phase 4.
 */
export const EXAM_IGNORE_PATTERN = '.exercises/exam-*/';
