import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TrackSummary } from '@eduagent/shared';
import { sampledSparklineDays, TrackSparkline } from './track-gallery';

const TRACK: TrackSummary = {
  id: 'track-1',
  slug: 'sql-interview',
  title: 'SQL Interview Prep',
  goalType: 'interview',
  status: 'active',
  accent: 'violet',
  createdAt: '2026-07-01T00:00:00Z',
  lastActiveAt: '2026-07-19T00:00:00Z',
  day: { head: 3, total: 5 },
  completedDays: [1, 4],
  nextPlannedDate: '2026-07-20',
  conceptSlugs: ['joins'],
  topicSlugs: ['sql'],
};

describe('track gallery sparkline', () => {
  it('fills only completedDays membership and rings the real HEAD', () => {
    const html = renderToStaticMarkup(<TrackSparkline track={TRACK} />);
    expect(html.match(/fill="var\(--success\)"/g) ?? []).toHaveLength(2);
    expect(html.match(/stroke="var\(--accent\)"/g) ?? []).toHaveLength(1);
    // Day 2 is before HEAD but is intentionally hollow, not inferred complete.
    expect(html.match(/stroke="var\(--border\)"/g) ?? []).toHaveLength(2);
  });

  it('caps long roadmaps while retaining the head day', () => {
    const days = sampledSparklineDays(60, 37);
    expect(days.length).toBeLessThanOrEqual(30);
    expect(days).toContain(37);
  });
});
