import type { DashboardData } from '@eduagent/shared';

/**
 * Pure data mapping for the dashboard charts (plans/04 §4, 05 §7): decay
 * series → Recharts rows, activity → contribution grid, and the small
 * formatting helpers the cards share. No React, fully unit-tested.
 */

export type DecaySeries = DashboardData['decaySeries'];
export type ActivityStripData = DashboardData['activity'];

/** One Recharts row: date + `<concept>` (past) / `<concept>:proj` (projection). */
export type DecayChartRow = { date: string } & Record<string, number | string>;

export interface DecayChartData {
  rows: DecayChartRow[];
  concepts: Array<{ concept: string; name: string }>;
  /** `${concept}:${date}` keys where a commit boosted the curve (up-arrow marks). */
  boosts: Set<string>;
}

/** Projection dataKey for a concept ("solid past, dotted projection"). */
export function projKey(concept: string): string {
  return `${concept}:proj`;
}

/**
 * Merges per-concept point lists into date-keyed rows. Points up to and
 * including `today` land on the solid past line; points from `today` on land
 * on the dotted projection line (today belongs to both so the lines join).
 * A rise between consecutive past points can only come from an assessment
 * anchor (decay is monotonically down) — those dates get boost markers.
 */
export function buildDecayChart(series: DecaySeries, today: string): DecayChartData {
  const rowsByDate = new Map<string, DecayChartRow>();
  const boosts = new Set<string>();
  const concepts: DecayChartData['concepts'] = [];

  for (const { concept, name, points } of series) {
    concepts.push({ concept, name });
    let previous: number | null = null;
    for (const point of points) {
      let row = rowsByDate.get(point.date);
      if (!row) {
        row = { date: point.date };
        rowsByDate.set(point.date, row);
      }
      if (point.date <= today) {
        row[concept] = point.effective;
        if (previous !== null && point.effective > previous + 1e-9) {
          boosts.add(`${concept}:${point.date}`);
        }
        previous = point.effective;
      }
      if (point.date >= today) {
        row[projKey(concept)] = point.effective;
      }
    }
  }

  const rows = [...rowsByDate.values()].sort((a, b) =>
    (a.date as string).localeCompare(b.date as string),
  );
  return { rows, concepts, boosts };
}

/**
 * ≤ `count` evenly spaced tick dates including the first and last row
 * (plans/05 §7: no more than 4 axis ticks).
 */
export function tickDates(rows: Array<{ date: string }>, count = 4): string[] {
  if (rows.length === 0) return [];
  if (rows.length <= count) return rows.map((row) => row.date);
  const ticks: string[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (rows.length - 1)) / (count - 1));
    const date = rows[index]!.date;
    if (!ticks.includes(date)) ticks.push(date);
  }
  return ticks;
}

// ---------------------------------------------------------------------------
// Activity strip (90-day contribution grid)
// ---------------------------------------------------------------------------

export interface ActivityCell {
  date: string;
  count: number;
}

/**
 * Sunday-aligned week columns for the contribution grid. The first column is
 * padded with nulls so weekday rows line up; the API contract guarantees the
 * entries are oldest→newest and end today.
 */
export function buildActivityWeeks(activity: ActivityStripData): Array<Array<ActivityCell | null>> {
  const weeks: Array<Array<ActivityCell | null>> = [];
  let week: Array<ActivityCell | null> = [];
  activity.forEach((entry, index) => {
    if (index === 0) {
      const weekday = new Date(`${entry.date}T12:00:00Z`).getUTCDay();
      for (let i = 0; i < weekday; i++) week.push(null);
    }
    week.push(entry);
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  });
  if (week.length > 0) weeks.push(week);
  return weeks;
}

/** Intensity bucket 0–4 relative to the strip's max (0 stays 0). */
export function activityLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Jul 12" from an ISO date or datetime (plans/05 §7 axis rule). */
export function formatShortDate(iso: string): string {
  const [year, month, day] = iso.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return iso;
  return `${MONTHS[month - 1]} ${day}`;
}

/** Relative time for the timeline feed: "just now" · "3h ago" · "Jul 12". */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatShortDate(iso);
}

/** Whole days from `todayIso` to `dateIso` (negative = past). */
export function daysUntil(dateIso: string, todayIso: string): number {
  const target = Date.parse(`${dateIso.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayIso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(target) || Number.isNaN(today)) return 0;
  return Math.round((target - today) / 86_400_000);
}

/** "N due · est. M min" — ~2 minutes per queued concept, minimum 1. */
export function reviewEstimateMinutes(itemCount: number): number {
  return itemCount <= 0 ? 0 : Math.max(1, itemCount * 2);
}
