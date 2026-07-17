import { describe, expect, it } from 'vitest';
import {
  activityLevel,
  buildActivityWeeks,
  buildDecayChart,
  daysUntil,
  formatRelativeTime,
  formatShortDate,
  projKey,
  reviewEstimateMinutes,
  tickDates,
  type DecaySeries,
} from './dashboard-data';

const SERIES: DecaySeries = [
  {
    concept: 'inner-join',
    name: 'INNER JOIN',
    points: [
      { date: '2026-07-10', effective: 0.5 },
      { date: '2026-07-11', effective: 0.48 },
      // commit boost: the curve jumps up on the 12th
      { date: '2026-07-12', effective: 0.72 },
      { date: '2026-07-13', effective: 0.7 },
      // projection
      { date: '2026-07-14', effective: 0.67 },
      { date: '2026-07-15', effective: 0.64 },
    ],
  },
  {
    concept: 'left-join',
    name: 'LEFT JOIN',
    points: [
      { date: '2026-07-12', effective: 0.4 },
      { date: '2026-07-13', effective: 0.37 },
      { date: '2026-07-14', effective: 0.34 },
    ],
  },
];

const TODAY = '2026-07-13';

describe('buildDecayChart', () => {
  const chart = buildDecayChart(SERIES, TODAY);

  it('splits past (≤ today) from projection (≥ today), sharing the today point', () => {
    const today = chart.rows.find((row) => row.date === TODAY)!;
    expect(today['inner-join']).toBe(0.7);
    expect(today[projKey('inner-join')]).toBe(0.7);

    const past = chart.rows.find((row) => row.date === '2026-07-11')!;
    expect(past['inner-join']).toBe(0.48);
    expect(past[projKey('inner-join')]).toBeUndefined();

    const future = chart.rows.find((row) => row.date === '2026-07-14')!;
    expect(future['inner-join']).toBeUndefined();
    expect(future[projKey('inner-join')]).toBe(0.67);
  });

  it('merges series into date-sorted rows', () => {
    expect(chart.rows.map((row) => row.date)).toEqual([
      '2026-07-10',
      '2026-07-11',
      '2026-07-12',
      '2026-07-13',
      '2026-07-14',
      '2026-07-15',
    ]);
    const jul12 = chart.rows.find((row) => row.date === '2026-07-12')!;
    expect(jul12['inner-join']).toBe(0.72);
    expect(jul12['left-join']).toBe(0.4);
  });

  it('marks rises between past points as commit boosts — decay only ever falls', () => {
    expect(chart.boosts).toEqual(new Set(['inner-join:2026-07-12']));
  });

  it('never marks boosts inside the projection', () => {
    const projOnly = buildDecayChart(
      [
        {
          concept: 'x',
          name: 'X',
          points: [
            { date: '2026-07-14', effective: 0.3 },
            { date: '2026-07-15', effective: 0.5 },
          ],
        },
      ],
      TODAY,
    );
    expect(projOnly.boosts.size).toBe(0);
  });

  it('keeps concept order and names for direct labels', () => {
    expect(chart.concepts).toEqual([
      { concept: 'inner-join', name: 'INNER JOIN' },
      { concept: 'left-join', name: 'LEFT JOIN' },
    ]);
  });
});

describe('tickDates', () => {
  it('returns everything when at or under the cap', () => {
    expect(tickDates([{ date: 'a' }, { date: 'b' }])).toEqual(['a', 'b']);
  });

  it('spaces ≤4 ticks including first and last', () => {
    const rows = Array.from({ length: 45 }, (_, i) => ({ date: String(i).padStart(2, '0') }));
    const ticks = tickDates(rows);
    expect(ticks).toHaveLength(4);
    expect(ticks[0]).toBe('00');
    expect(ticks[3]).toBe('44');
  });
});

describe('activity grid', () => {
  it('pads the first week to Sunday alignment and chunks by 7', () => {
    // 2026-07-01 is a Wednesday (UTC weekday 3).
    const activity = Array.from({ length: 11 }, (_, i) => ({
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      count: i,
    }));
    const weeks = buildActivityWeeks(activity);
    expect(weeks[0]).toHaveLength(7);
    expect(weeks[0]!.slice(0, 3)).toEqual([null, null, null]);
    expect(weeks[0]![3]).toEqual({ date: '2026-07-01', count: 0 });
    // 3 pad + 11 entries = 14 slots = exactly 2 weeks
    expect(weeks).toHaveLength(2);
    expect(weeks[1]![6]).toEqual({ date: '2026-07-11', count: 10 });
  });

  it('activityLevel buckets 1–4 relative to max, 0 for none', () => {
    expect(activityLevel(0, 8)).toBe(0);
    expect(activityLevel(1, 8)).toBe(1);
    expect(activityLevel(4, 8)).toBe(2);
    expect(activityLevel(8, 8)).toBe(4);
    expect(activityLevel(3, 0)).toBe(0);
  });
});

describe('formatting', () => {
  it('formatShortDate renders "Jul 12" from dates and datetimes', () => {
    expect(formatShortDate('2026-07-12')).toBe('Jul 12');
    expect(formatShortDate('2026-01-03T09:30:00.000Z')).toBe('Jan 3');
  });

  it('formatRelativeTime steps just now → m → h → d → short date', () => {
    const now = new Date('2026-07-16T12:00:00Z');
    expect(formatRelativeTime('2026-07-16T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-07-16T11:20:00Z', now)).toBe('40m ago');
    expect(formatRelativeTime('2026-07-16T05:00:00Z', now)).toBe('7h ago');
    expect(formatRelativeTime('2026-07-13T11:00:00Z', now)).toBe('3d ago');
    expect(formatRelativeTime('2026-07-01T11:00:00Z', now)).toBe('Jul 1');
  });

  it('daysUntil counts calendar days, negative in the past', () => {
    expect(daysUntil('2026-07-20', '2026-07-16')).toBe(4);
    expect(daysUntil('2026-07-16', '2026-07-16')).toBe(0);
    expect(daysUntil('2026-07-14', '2026-07-16')).toBe(-2);
  });

  it('reviewEstimateMinutes: ~2 min per item, 0 for empty', () => {
    expect(reviewEstimateMinutes(0)).toBe(0);
    expect(reviewEstimateMinutes(1)).toBe(2);
    expect(reviewEstimateMinutes(3)).toBe(6);
  });
});
