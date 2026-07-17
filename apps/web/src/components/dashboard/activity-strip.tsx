'use client';

import { useMemo } from 'react';
import type { DashboardData } from '@eduagent/shared';
import {
  activityLevel,
  buildActivityWeeks,
  formatShortDate,
} from '@/lib/dashboard-data';
import { cn } from '@/lib/utils';

/**
 * 90-day contribution strip (plans/04 §4): Sunday-aligned week columns,
 * intensity = --accent opacity ramp (one accent family, 05 §7). Native
 * tooltips + aria-labels carry the text equivalents (05 §9).
 */
const LEVEL_OPACITY = [0, 0.25, 0.45, 0.7, 1];

export function ActivityStrip({ activity }: { activity: DashboardData['activity'] }) {
  const weeks = useMemo(() => buildActivityWeeks(activity), [activity]);
  const max = useMemo(() => Math.max(0, ...activity.map((a) => a.count)), [activity]);
  const total = useMemo(() => activity.reduce((sum, a) => sum + a.count, 0), [activity]);

  return (
    <section aria-label="90-day activity" className="flex flex-col gap-4 rounded-lg border bg-surface p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lead font-medium">Activity</h2>
        <p className="font-mono text-caption text-muted-foreground">
          <span className="numeric">{total}</span> events · last 90 days
        </p>
      </header>

      <div className="flex gap-[3px] overflow-x-auto pb-1" role="img" aria-label={`Activity grid: ${total} events across the last 90 days`}>
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="flex flex-col gap-[3px]">
            {week.map((cell, dayIndex) => {
              if (!cell) {
                return <span key={dayIndex} className="size-3 rounded-[3px]" aria-hidden />;
              }
              const level = activityLevel(cell.count, max);
              return (
                <span
                  key={cell.date}
                  title={`${formatShortDate(cell.date)} · ${cell.count} event${cell.count === 1 ? '' : 's'}`}
                  className={cn('size-3 rounded-[3px]', level === 0 && 'bg-surface-2')}
                  style={
                    level > 0
                      ? { backgroundColor: 'var(--accent)', opacity: LEVEL_OPACITY[level] }
                      : undefined
                  }
                />
              );
            })}
          </div>
        ))}
      </div>

      {total === 0 ? (
        <p className="text-caption text-muted-foreground">
          No activity yet — every session, commit, and passed exercise lights a square.
        </p>
      ) : null}
    </section>
  );
}
