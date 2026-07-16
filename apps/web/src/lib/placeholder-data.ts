/**
 * Scaffold-only placeholder state, consolidated so every surface tells the
 * SAME story: a brand-new learner with an empty memory — matching the empty
 * states (plans/05 §8; no fake counts per 05 §6.4). Phase 2–3 replace these
 * with /auth/me and /api/reviews/due; flip the values locally to preview the
 * populated shell.
 */
export const PLACEHOLDER_USER = {
  name: 'Alex',
  /** 0 = no streak yet; the flame renders only when > 0. */
  streakDays: 0,
};

/** Review due-count for the sidebar badge; the badge renders only when > 0. */
export const PLACEHOLDER_DUE_COUNT = 0;
