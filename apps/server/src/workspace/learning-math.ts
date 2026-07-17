/**
 * Decay math per plans/02 §4, needed here for the state digest's effective-
 * mastery notes. plans/02 places the full learning-math module (decay + SRS
 * projections + readiness) in packages/shared for reuse by the dashboard
 * charts; it doesn't exist yet — when it lands, these should be re-exported
 * from there and this file deleted. Keep the formulas identical.
 */

const MS_PER_DAY = 86_400_000;

/** half_life_days = clamp(7 * 2^review_count, 7, 180) */
export function halfLifeDays(reviewCount: number): number {
  return Math.min(180, Math.max(7, 7 * 2 ** reviewCount));
}

/** effective = mastery * exp(-ln(2) * days_since_last_assessed / half_life_days) */
export function effectiveMastery(
  mastery: number,
  reviewCount: number,
  lastAssessed: string,
  now: Date,
): number {
  const daysSince = Math.max(0, (now.getTime() - Date.parse(lastAssessed)) / MS_PER_DAY);
  return mastery * Math.exp((-Math.LN2 * daysSince) / halfLifeDays(reviewCount));
}

/** UI/digest "fading" marker: effective has slipped >0.1 below raw (plans/02 §4). */
export function isFading(mastery: number, effective: number): boolean {
  return effective < mastery - 0.1;
}
