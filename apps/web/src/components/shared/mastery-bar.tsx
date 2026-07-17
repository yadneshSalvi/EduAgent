'use client';

import { masteryColor } from '@/lib/mastery';
import { cn } from '@/lib/utils';

/**
 * Static mastery bar on the 05 §2 ramp — reused by the memory explorer file
 * viewer, dashboard cells, and quiz feedback (Phases 2–4). For animated
 * from→to bars use DeltaBar.
 */
export function MasteryBar({
  value,
  className,
  'aria-label': ariaLabel,
}: {
  value: number;
  className?: string;
  'aria-label'?: string;
}) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(clamped.toFixed(2))}
      aria-label={ariaLabel ?? 'mastery'}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-surface-2', className)}
    >
      <div
        className="h-full rounded-full"
        style={{ width: `${clamped * 100}%`, backgroundColor: masteryColor(clamped) }}
      />
    </div>
  );
}
