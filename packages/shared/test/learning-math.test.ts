import { describe, expect, it } from 'vitest';
import {
  addDays,
  decayed,
  effectiveMastery,
  halfLifeDays,
  isFading,
  localDate,
  readinessScore,
  srsAfterFail,
  srsAfterPass,
  streakDays,
} from '../src/learning-math';

/**
 * Golden cases for the plans/02 §4 formulas — every expected number below is
 * hand-derived from the plan's math, never from the implementation.
 */

describe('halfLifeDays — clamp(7 * 2^review_count, 7, 180)', () => {
  it('doubles from 7 and clamps at 180', () => {
    expect(halfLifeDays(0)).toBe(7);
    expect(halfLifeDays(1)).toBe(14);
    expect(halfLifeDays(2)).toBe(28);
    expect(halfLifeDays(3)).toBe(56);
    expect(halfLifeDays(4)).toBe(112);
    // 7 * 2^5 = 224 → clamped
    expect(halfLifeDays(5)).toBe(180);
    expect(halfLifeDays(10)).toBe(180);
  });

  it('never drops below 7 (defensive against bad review counts)', () => {
    expect(halfLifeDays(-3)).toBe(7);
  });
});

describe('effectiveMastery — mastery * exp(-ln2 * days / half_life)', () => {
  const now = new Date('2026-07-16T00:00:00Z');

  it('exactly one half-life halves the mastery (rc=0: 7 days)', () => {
    // 0.8 * 2^(-7/7) = 0.8 * 0.5 = 0.4
    expect(effectiveMastery(0.8, 0, '2026-07-09', now)).toBeCloseTo(0.4, 12);
  });

  it('rc=2 (half-life 28) after 14 days decays by 1/√2', () => {
    // 0.72 * 2^(-14/28) = 0.72 / √2 = 0.509116882454…
    expect(effectiveMastery(0.72, 2, '2026-07-02', now)).toBeCloseTo(0.72 / Math.SQRT2, 12);
  });

  it('zero days elapsed → effective equals raw mastery', () => {
    expect(effectiveMastery(0.63, 1, '2026-07-16T00:00:00Z', now)).toBe(0.63);
  });

  it('a future last_assessed clamps to zero elapsed days (no anti-decay)', () => {
    expect(effectiveMastery(0.5, 0, '2026-08-01', now)).toBe(0.5);
  });

  it('accepts datetimes too (2 half-lives → quarter)', () => {
    // rc=0, 14 days = 2 half-lives: 0.6 * 0.25 = 0.15
    expect(effectiveMastery(0.6, 0, '2026-07-02T00:00:00Z', now)).toBeCloseTo(0.15, 12);
  });
});

describe('decayed — explicit day-count decay (chart projections)', () => {
  it('matches the closed form', () => {
    // 0.8 * 2^(-28/56) = 0.8 / √2 = 0.565685424949…
    expect(decayed(0.8, 3, 28)).toBeCloseTo(0.8 / Math.SQRT2, 12);
    expect(decayed(0.8, 3, 0)).toBe(0.8);
    expect(decayed(0.8, 3, -5)).toBe(0.8);
  });
});

describe('isFading — effective < mastery - 0.1', () => {
  it('is strict at the boundary (float-exact values)', () => {
    // 0.75 - 0.1 = 0.65 exactly in binary floating point.
    expect(isFading(0.75, 0.65)).toBe(false);
    expect(isFading(0.75, 0.649)).toBe(true);
    expect(isFading(0.8, 0.75)).toBe(false);
    expect(isFading(0.8, 0.69)).toBe(true);
  });
});

describe('SRS transitions (SM-2 lite)', () => {
  it('pass: interval rounds up through ease, ease +0.05', () => {
    // The memory-skill example: interval 3 → round(3*2.5)=8, ease 2.5 → 2.55.
    expect(srsAfterPass({ interval_days: 3, ease: 2.5, lapses: 1 })).toEqual({
      interval_days: 8,
      ease: 2.55,
      lapses: 1,
    });
  });

  it('pass: new-concept progression 1 → 3 (round(1*2.5))', () => {
    expect(srsAfterPass({ interval_days: 1, ease: 2.5, lapses: 0 }).interval_days).toBe(3);
  });

  it('pass: ease caps at 2.8', () => {
    expect(srsAfterPass({ interval_days: 10, ease: 2.78, lapses: 0 })).toEqual({
      interval_days: 28, // round(10 * 2.78) = 28
      ease: 2.8,
      lapses: 0,
    });
    expect(srsAfterPass({ interval_days: 10, ease: 2.8, lapses: 0 }).ease).toBe(2.8);
  });

  it('fail: interval resets to 1, ease -0.2 floored at 1.3, lapse counted', () => {
    expect(srsAfterFail({ interval_days: 8, ease: 2.55, lapses: 1 })).toEqual({
      interval_days: 1,
      ease: 2.35,
      lapses: 2,
    });
    expect(srsAfterFail({ interval_days: 4, ease: 1.4, lapses: 0 }).ease).toBe(1.3);
    expect(srsAfterFail({ interval_days: 4, ease: 1.3, lapses: 0 }).ease).toBe(1.3);
  });
});

describe('readinessScore — 100 * Σ(w·e) / Σ(w)', () => {
  it('matches the hand-computed weighted mean', () => {
    // 100 * (1.0*0.4 + 1.5*0.8) / 2.5 = 100 * 1.6/2.5 = 64
    expect(
      readinessScore([
        { weight: 1.0, effective: 0.4 },
        { weight: 1.5, effective: 0.8 },
      ]),
    ).toBeCloseTo(64, 12);
  });

  it('weights normalize (single item → 100 * effective)', () => {
    expect(readinessScore([{ weight: 2, effective: 0.5 }])).toBe(50);
  });

  it('empty (or zero-weight) input → 0', () => {
    expect(readinessScore([])).toBe(0);
  });
});

describe('localDate / addDays', () => {
  it('renders the calendar date in the given timezone', () => {
    const instant = new Date('2026-07-16T03:00:00Z');
    expect(localDate(instant, 'UTC')).toBe('2026-07-16');
    // 03:00 UTC = 20:00 the previous day in Los Angeles (PDT, UTC-7).
    expect(localDate(instant, 'America/Los_Angeles')).toBe('2026-07-15');
  });

  it('falls back to UTC on an invalid timezone instead of throwing', () => {
    expect(localDate(new Date('2026-07-16T03:00:00Z'), 'Not/AZone')).toBe('2026-07-16');
  });

  it('addDays does UTC calendar arithmetic across month bounds', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-07-01', -1)).toBe('2026-06-30');
  });
});

describe('streakDays — consecutive days (user tz) with a counting commit', () => {
  const now = new Date('2026-07-16T20:00:00Z');

  it('counts back from today through consecutive days', () => {
    const streak = streakDays(
      [
        '2026-07-16T12:00:00Z',
        '2026-07-15T09:00:00Z',
        '2026-07-14T22:00:00Z',
        // gap on 07-13
        '2026-07-12T10:00:00Z',
      ],
      'UTC',
      now,
    );
    expect(streak).toBe(3);
  });

  it('a commit-less today does not break the streak (grace day)', () => {
    expect(streakDays(['2026-07-15T09:00:00Z', '2026-07-14T09:00:00Z'], 'UTC', now)).toBe(2);
  });

  it('no commit today or yesterday → streak 0', () => {
    expect(streakDays(['2026-07-13T09:00:00Z'], 'UTC', now)).toBe(0);
    expect(streakDays([], 'UTC', now)).toBe(0);
  });

  it('day membership follows the user timezone', () => {
    // 2026-07-16T03:00Z is still 07-15 in Los Angeles; with "now" late on
    // 07-15 LA time, that commit counts as today there but as yesterday in UTC.
    const instants = ['2026-07-16T03:00:00Z'];
    const laNow = new Date('2026-07-16T04:00:00Z'); // 07-15 21:00 in LA
    expect(streakDays(instants, 'America/Los_Angeles', laNow)).toBe(1);
    expect(streakDays(instants, 'UTC', new Date('2026-07-17T10:00:00Z'))).toBe(1); // grace
  });

  it('multiple commits on one day count once', () => {
    expect(
      streakDays(['2026-07-16T01:00:00Z', '2026-07-16T13:00:00Z'], 'UTC', now),
    ).toBe(1);
  });
});
