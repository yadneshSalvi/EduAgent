/**
 * Learning math (`02` §4): decay, SM-2-lite SRS transitions, readiness, and
 * streak — the single implementation shared by the server (digest, dashboard,
 * SRS derivations) and the web charts. Formulas are law; change them only by
 * changing the plan.
 */

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

/** `half_life_days = clamp(7 * 2^review_count, 7, 180)` */
export function halfLifeDays(reviewCount: number): number {
  return Math.min(180, Math.max(7, 7 * 2 ** reviewCount));
}

/**
 * `effective = mastery * exp(-ln(2) * days_since_last_assessed / half_life_days)`
 *
 * `lastAssessed` is an ISO date or datetime; a bare date parses as midnight
 * UTC. A future `lastAssessed` clamps to zero elapsed days (no anti-decay).
 */
export function effectiveMastery(
  mastery: number,
  reviewCount: number,
  lastAssessed: string,
  now: Date,
): number {
  const daysSince = Math.max(0, (now.getTime() - Date.parse(lastAssessed)) / MS_PER_DAY);
  return decayed(mastery, reviewCount, daysSince);
}

/** The same decay curve over an explicit day count (chart projections). */
export function decayed(mastery: number, reviewCount: number, daysSince: number): number {
  return mastery * Math.exp((-Math.LN2 * Math.max(0, daysSince)) / halfLifeDays(reviewCount));
}

/** UI "fading" marker (amber treatment): effective slipped >0.1 below raw. */
export function isFading(mastery: number, effective: number): boolean {
  return effective < mastery - 0.1;
}

// ---------------------------------------------------------------------------
// SRS (SM-2 lite) — the AGENT applies these via the memory skill; the server
// only derives projections from them. Kept here so both sides agree.
// ---------------------------------------------------------------------------

export const SRS_EASE_MIN = 1.3;
export const SRS_EASE_MAX = 2.8;

export interface SrsScheduleState {
  interval_days: number;
  ease: number;
  lapses: number;
}

/** Ease is written to queue.yaml with 2 decimals — keep float drift out of the files. */
const roundEase = (ease: number): number => Math.round(ease * 100) / 100;

/**
 * grade ≥ pass: `interval = round(interval * ease)`, `ease += 0.05` (cap 2.8).
 * (The concept's `review_count` also increments — that lives in mastery.yaml,
 * not in this schedule state.)
 */
export function srsAfterPass(state: SrsScheduleState): SrsScheduleState {
  return {
    interval_days: Math.max(1, Math.round(state.interval_days * state.ease)),
    ease: roundEase(Math.min(SRS_EASE_MAX, state.ease + 0.05)),
    lapses: state.lapses,
  };
}

/** fail: `interval = 1`, `ease = max(1.3, ease - 0.2)`, `lapses += 1`. */
export function srsAfterFail(state: SrsScheduleState): SrsScheduleState {
  return {
    interval_days: 1,
    ease: roundEase(Math.max(SRS_EASE_MIN, state.ease - 0.2)),
    lapses: state.lapses + 1,
  };
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export interface ReadinessItem {
  /** Track item weight (importance for readiness). */
  weight: number;
  /** Effective (decayed) mastery, 0..1; 0 for concepts not yet assessed. */
  effective: number;
}

/** `readiness = 100 * Σ(weight_i * effective_i) / Σ(weight_i)`; empty → 0. */
export function readinessScore(items: ReadinessItem[]): number {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return 0;
  const weighted = items.reduce((sum, item) => sum + item.weight * item.effective, 0);
  return (100 * weighted) / totalWeight;
}

// ---------------------------------------------------------------------------
// Calendar days & streak
// ---------------------------------------------------------------------------

/**
 * The calendar date (`YYYY-MM-DD`) of an instant in a IANA timezone. An
 * unknown/invalid timezone falls back to UTC rather than throwing — learner
 * profiles are agent-written and must never take the dashboard down.
 */
export function localDate(instant: Date, timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant);
  } catch {
    return instant.toISOString().slice(0, 10);
  }
}

/** ISO date + N days (UTC calendar arithmetic; N may be negative). */
export function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
}

/**
 * Streak (`02` §4): consecutive days in the user's timezone with ≥1 counting
 * commit. `instants` are the commit datetimes (callers pre-filter to types
 * learn/review/exam). A day with no commit YET (today) doesn't break the
 * streak — counting starts at yesterday when today is empty.
 */
export function streakDays(instants: string[], timeZone: string, now: Date): number {
  const days = new Set(instants.map((iso) => localDate(new Date(iso), timeZone)));
  const today = localDate(now, timeZone);
  let cursor = days.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}
