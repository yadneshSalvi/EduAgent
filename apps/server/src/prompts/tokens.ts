/**
 * Prompt budgets (plans/03 §6.4). The estimator is the standard ~4 chars per
 * token heuristic for English/markdown — good enough for budget tests; we
 * never bill by it.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Hard cap for the per-turn state digest (plans/03 §6.4: "digest ≤ ~600 tokens"). */
export const STATE_DIGEST_TOKEN_BUDGET = 600;

/** Budget for thread-level developerInstructions — skills carry the bulk, these stay lean. */
export const MODE_INSTRUCTIONS_TOKEN_BUDGET = 800;

/**
 * Onboarding runs before the learner model exists and its first write MUST
 * zod-validate (Phase 1 QA finding M2), so the exact file templates ride in
 * the instructions themselves — a deliberate exception to the lean budget.
 */
export const ONBOARDING_INSTRUCTIONS_TOKEN_BUDGET = 1_700;

/**
 * Exam templates carry the full generation/grading procedure plus the
 * targeting list and integrity rules — a deliberate exception to the lean
 * mode budget (the teach skill doesn't cover examining).
 */
export const EXAM_INSTRUCTIONS_TOKEN_BUDGET = 1_300;
