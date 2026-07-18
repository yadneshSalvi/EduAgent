import { addDays, localDate } from '@eduagent/shared';

/**
 * Timezone-aware instants for the seeder. All history is expressed as
 * "N days ago at HH:MM local" in the learner's IANA timezone; these helpers
 * turn that into concrete UTC instants without hardcoding a UTC offset
 * (so a January reseed of a Los Angeles learner still lands commits on the
 * intended local calendar days).
 */

const MS_PER_MINUTE = 60_000;

/** `YYYY-MM-DDTHH:mm:ss` as rendered in `tz` (24h clock). */
function renderInTz(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * The UTC instant whose wall-clock rendering in `tz` is `dateIso THH:mm:ss`.
 * Iterative offset correction (converges in ≤2 steps for real timezones;
 * DST-gap times land on the nearest valid instant).
 */
export function instantForLocal(
  dateIso: string,
  hour: number,
  minute: number,
  second: number,
  tz: string,
): Date {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const target = `${dateIso}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  let guessMs = Date.parse(`${target}Z`);
  for (let i = 0; i < 3; i++) {
    const diff = Date.parse(`${renderInTz(new Date(guessMs), tz)}Z`) - Date.parse(`${target}Z`);
    if (diff === 0) break;
    guessMs -= diff;
  }
  return new Date(guessMs);
}

/**
 * The seeder's clock: everything is relative to `now` in `tz`. Day 0 is
 * "today" (the seed day), day N is N calendar days earlier.
 */
export class SeedClock {
  /** Local calendar date of the seed instant. */
  readonly today: string;

  constructor(
    readonly now: Date,
    readonly tz: string,
  ) {
    this.today = localDate(now, tz);
  }

  /** ISO local calendar date `daysAgo` days before today. */
  dayIso(daysAgo: number): string {
    return addDays(this.today, -daysAgo);
  }

  /**
   * Instant at local wall-clock time on the day `daysAgo` days back. Day-0
   * instants are clamped to at least 20 minutes before `now` so a morning
   * seed run never produces future-dated commits.
   */
  at(daysAgo: number, hour: number, minute: number, second = 0): Date {
    const instant = instantForLocal(this.dayIso(daysAgo), hour, minute, second, this.tz);
    if (daysAgo === 0) {
      const latest = this.now.getTime() - 20 * MS_PER_MINUTE;
      if (instant.getTime() > latest) return new Date(latest);
    }
    return instant;
  }
}
