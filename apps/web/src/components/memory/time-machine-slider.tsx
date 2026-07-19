'use client';

import type { MemoryCommitType, TimelineEntry } from '@eduagent/shared';
import { shortSha } from '@/lib/commit-format';
import { formatShortDate } from '@/lib/dashboard-data';
import { cn } from '@/lib/utils';

/**
 * The Time Machine (plans/04 §7): a horizontal slider across every memory
 * commit (oldest → newest), dots colored by commit type. Two thumbs scrub
 * refs A/B; when they differ the explorer switches to diff mode. Native
 * range inputs underneath keep it fully keyboard accessible.
 */
const TYPE_DOT: Record<MemoryCommitType, string> = {
  learn: 'bg-primary',
  review: 'bg-success',
  exam: 'bg-warn',
  misconception: 'bg-danger',
  profile: 'bg-muted-foreground',
  seed: 'bg-muted-foreground',
  system: 'bg-muted-foreground',
  plan: 'bg-primary',
};

export interface TimeMachineRange {
  /** Index into the oldest-first commit list — A ≤ B. */
  a: number;
  b: number;
}

export function TimeMachineSlider({
  commits,
  range,
  onChange,
}: {
  /** Oldest first. */
  commits: TimelineEntry[];
  range: TimeMachineRange;
  onChange: (range: TimeMachineRange) => void;
}) {
  const max = commits.length - 1;
  if (max < 1) return null;
  const posPct = (index: number) => (index / max) * 100;
  const from = commits[range.a]!;
  const to = commits[range.b]!;

  const setA = (value: number) => onChange({ a: Math.min(value, range.b), b: range.b });
  const setB = (value: number) => onChange({ a: range.a, b: Math.max(value, range.a) });

  return (
    <div className="flex flex-col gap-2">
      {/* h-10: the strip is the sliders' hit surface (05 §9). */}
      <div className="relative h-10">
        {/* Track + selected span */}
        <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-border" />
        <div className="absolute inset-x-2 top-1/2 h-0.5 -translate-y-1/2">
          <div
            className="absolute top-0 h-full rounded-full bg-primary/60"
            style={{
              left: `${posPct(range.a)}%`,
              width: `${posPct(range.b) - posPct(range.a)}%`,
            }}
          />
        </div>
        {/* Commit dots */}
        <div className="absolute inset-x-2 top-1/2 -translate-y-1/2">
          {commits.map((commit, index) => (
            <span
              key={commit.sha}
              title={`${shortSha(commit.sha)} · ${commit.headline}`}
              className={cn(
                'absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full',
                TYPE_DOT[commit.type],
                (index < range.a || index > range.b) && 'opacity-40',
              )}
              style={{ left: `${posPct(index)}%` }}
            />
          ))}
        </div>
        {/* Dual thumbs — the A input sits on top near the left edge so both stay reachable. */}
        <input
          type="range"
          aria-label="Time machine: from commit"
          min={0}
          max={max}
          value={range.a}
          onChange={(event) => setA(Number(event.target.value))}
          className="tm-range"
          style={{ zIndex: range.a === max ? 4 : 3 }}
        />
        <input
          type="range"
          aria-label="Time machine: to commit"
          min={0}
          max={max}
          value={range.b}
          onChange={(event) => setB(Number(event.target.value))}
          className="tm-range"
          style={{ zIndex: 2 }}
        />
      </div>

      <div className="flex items-center justify-between gap-3 font-mono text-caption text-muted-foreground">
        <span>
          A · {shortSha(from.sha)} · {formatShortDate(from.date)}
        </span>
        <span>
          B · {shortSha(to.sha)} · {formatShortDate(to.date)}
        </span>
      </div>
    </div>
  );
}
