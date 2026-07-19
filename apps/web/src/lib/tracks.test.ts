import { describe, expect, it } from 'vitest';
import type { TrackDetail } from '@eduagent/shared';
import { formatRoadmapDate, roadmapDayState, type RoadmapDay } from './tracks';

function day(
  value: number,
  status: RoadmapDay['status'] = 'upcoming',
  sessionCount = 0,
): RoadmapDay {
  return {
    day: value,
    title: `Day ${value}`,
    status,
    completedOn: status === 'complete' ? '2026-07-18' : null,
    plannedDate: status === 'upcoming' ? `2026-07-${String(19 + value).padStart(2, '0')}` : null,
    topics: [{ topic: 'sql', concepts: ['joins'] }],
    subtopics: ['one', 'two'],
    sessionCount,
  };
}

describe('roadmap state derivation', () => {
  it('uses committed status and the real head, including out-of-order completion', () => {
    expect(roadmapDayState(day(12, 'complete'), 13)).toBe('complete');
    expect(roadmapDayState(day(13), 13)).toBe('current');
    expect(roadmapDayState(day(13, 'upcoming', 2), 13)).toBe('in-progress');
    expect(roadmapDayState(day(14), 13)).toBe('upcoming');
    expect(roadmapDayState(day(15), 13)).toBe('locked');
    // Day 18 stays complete even though it sits beyond HEAD.
    expect(roadmapDayState(day(18, 'complete'), 13)).toBe('complete');
  });

  it('formats the server-derived penciled date without local timezone drift', () => {
    expect(formatRoadmapDate('2026-07-23')).toBe('Thu, Jul 23');
    expect(formatRoadmapDate(null)).toBeNull();
  });
});

// Compile-time guard: the helper consumes the day shape returned by TrackDetail.
const _detailDay: NonNullable<TrackDetail['roadmap']>['days'][number] = day(1);
void _detailDay;
