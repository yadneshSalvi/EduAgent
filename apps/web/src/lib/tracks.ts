import type { TrackDetail } from '@eduagent/shared';

export type RoadmapDay = NonNullable<TrackDetail['roadmap']>['days'][number];
export type RoadmapDayState = 'complete' | 'in-progress' | 'current' | 'upcoming' | 'locked';

/** Derive presentation only from committed status, real HEAD, and session count. */
export function roadmapDayState(day: RoadmapDay, headDay: number | null): RoadmapDayState {
  if (day.status === 'complete') return 'complete';
  if (headDay === day.day) return day.sessionCount > 0 ? 'in-progress' : 'current';
  if (headDay !== null && day.day === headDay + 1) return 'upcoming';
  return 'locked';
}

export function formatRoadmapDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T12:00:00Z`));
}
