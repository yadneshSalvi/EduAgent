'use client';

import type { MasteryDelta } from '@eduagent/shared';
import { useTickedNumber } from '@/components/shared/number-ticker';
import { formatMastery, masteryColor } from '@/lib/mastery';

/**
 * Animated per-concept mastery delta (plans/05 §6.1): mono labels, fill
 * sweeping from→to on the mastery ramp (Ticker class). Reused by the diff
 * drawer, exam results, and the dashboard timeline (Phases 2–4).
 */
export function DeltaBar({ delta, delayMs = 0 }: { delta: MasteryDelta; delayMs?: number }) {
  const current = useTickedNumber(delta.to, { from: delta.from, durationMs: 800, delayMs });
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-3 font-mono text-caption">
        <span className="truncate text-muted-foreground">{delta.concept}</span>
        <span className="numeric shrink-0">
          <span className="text-muted-foreground">{formatMastery(delta.from)}→</span>
          <span style={{ color: masteryColor(current) }}>{formatMastery(current)}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={delta.to}
        aria-label={`${delta.concept} mastery ${formatMastery(delta.from)} to ${formatMastery(delta.to)}`}
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(1, Math.max(0, current)) * 100}%`, backgroundColor: masteryColor(current) }}
        />
      </div>
    </div>
  );
}
