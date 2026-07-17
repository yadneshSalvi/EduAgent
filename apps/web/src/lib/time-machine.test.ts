import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '@eduagent/shared';
import { summarizeRange } from './time-machine';

/** Newest-first, like /api/memory/log. */
const LOG: TimelineEntry[] = [
  {
    sha: 'g7',
    type: 'review',
    topic: 'sql',
    headline: 'quick recall check on joins',
    bullets: ['Resolved the WHERE-vs-ON mixup with a walkthrough'],
    deltas: [],
    date: '2026-07-16T08:00:00.000Z',
  },
  {
    sha: 'f6',
    type: 'learn',
    topic: 'sql',
    headline: 'left-join 0.20→0.40',
    bullets: [],
    deltas: [{ concept: 'left-join', from: 0.2, to: 0.4 }],
    date: '2026-07-15T08:00:00.000Z',
  },
  {
    sha: 'e5',
    type: 'learn',
    topic: 'sql',
    headline: 'inner-join 0.50→0.72',
    bullets: [],
    deltas: [{ concept: 'inner-join', from: 0.5, to: 0.72 }],
    date: '2026-07-14T09:00:00.000Z',
  },
  {
    sha: 'd4',
    type: 'misconception',
    topic: 'sql',
    headline: 'believes WHERE filters before JOIN completes',
    bullets: [],
    deltas: [],
    date: '2026-07-08T10:00:00.000Z',
  },
  {
    sha: 'c3',
    type: 'learn',
    topic: 'sql',
    headline: 'inner-join 0.00→0.50',
    bullets: [],
    deltas: [{ concept: 'inner-join', from: 0, to: 0.5 }],
    date: '2026-07-06T10:00:00.000Z',
  },
  {
    sha: 'b2',
    type: 'learn',
    topic: 'sql',
    headline: 'select-basics 0.55→0.80',
    bullets: [],
    deltas: [{ concept: 'select-basics', from: 0.55, to: 0.8 }],
    date: '2026-07-02T10:00:00.000Z',
  },
  {
    sha: 'a1',
    type: 'profile',
    topic: 'general',
    headline: 'initialize learner model',
    bullets: [],
    deltas: [],
    date: '2026-07-01T10:00:00.000Z',
  },
];

describe('summarizeRange', () => {
  it('covers exactly the from..to span (exclusive from, inclusive to)', () => {
    const summary = summarizeRange(LOG, 'b2', 'f6');
    expect(summary.commitCount).toBe(4); // c3, d4, e5, f6
    expect(summary.misconceptionsOpened).toBe(1);
  });

  it('nets deltas per concept across the range: first from → last to', () => {
    const summary = summarizeRange(LOG, 'b2', 'f6');
    expect(summary.deltas).toEqual([
      { concept: 'inner-join', from: 0, to: 0.72 },
      { concept: 'left-join', from: 0.2, to: 0.4 },
    ]);
  });

  it('counts newly planted concepts (first delta from 0)', () => {
    expect(summarizeRange(LOG, 'b2', 'f6').conceptsAdded).toBe(1); // inner-join
    expect(summarizeRange(LOG, 'a1', 'g7').conceptsAdded).toBe(1);
  });

  it('counts resolutions from headline/bullet mentions', () => {
    expect(summarizeRange(LOG, 'f6', 'g7').misconceptionsResolved).toBe(1);
    expect(summarizeRange(LOG, 'a1', 'f6').misconceptionsResolved).toBe(0);
  });

  it('tolerates a reversed scrub (B older than A)', () => {
    expect(summarizeRange(LOG, 'f6', 'b2')).toEqual(summarizeRange(LOG, 'b2', 'f6'));
  });

  it('returns an empty summary for unknown refs or a zero-width range', () => {
    expect(summarizeRange(LOG, 'nope', 'f6').commitCount).toBe(0);
    expect(summarizeRange(LOG, 'f6', 'f6').commitCount).toBe(0);
  });
});
