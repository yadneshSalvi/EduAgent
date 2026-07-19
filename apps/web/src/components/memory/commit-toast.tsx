'use client';

import { useCallback, useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { GitCommitHorizontal, X } from 'lucide-react';
import type { MemoryCommit } from '@eduagent/shared';
import { useTickedNumber } from '@/components/shared/number-ticker';
import { commitBadge, commitToastDurationMs, formatDiffStats, shortSha } from '@/lib/commit-format';
import { formatMastery, masteryColor } from '@/lib/mastery';

/**
 * Memory-commit toast (plans/05 §6.1, step 1): bottom-right, mono type badge
 * `learn(sql)`, headline, delta chips ticking 0.40→0.72 with a color sweep
 * toward mastery green. Auto-dismisses after `autoDismissMs` (default 15s,
 * NEXT_PUBLIC_COMMIT_TOAST_MS overrides); hover pins. Click → Diff Drawer.
 */
const AUTO_DISMISS_MS = commitToastDurationMs(process.env.NEXT_PUBLIC_COMMIT_TOAST_MS);
const MAX_DELTA_CHIPS = 3;

export function DeltaTickChip({
  concept,
  from,
  to,
  delayMs,
}: {
  concept: string;
  from: number;
  to: number;
  delayMs: number;
}) {
  const current = useTickedNumber(to, { from, durationMs: 800, delayMs });
  return (
    // Meter semantics carry the accessible value; the ticking spans are
    // aria-hidden so the surrounding live region announces the commit once,
    // not every animation frame (m5) — and innerText stays single-copy (p9a).
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={to}
      aria-label={`${concept} mastery ${formatMastery(from)} to ${formatMastery(to)}`}
      className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption"
    >
      <span aria-hidden className="text-muted-foreground">
        {concept}
      </span>
      <span aria-hidden className="numeric">
        <span className="text-muted-foreground">{formatMastery(from)}→</span>
        <span style={{ color: masteryColor(current) }}>{formatMastery(current)}</span>
      </span>
    </span>
  );
}

interface CommitToastProps {
  commit: MemoryCommit;
  onOpen: () => void;
  onDismiss: () => void;
  /** Auto-dismiss window; defaults to the env-configurable 15s. */
  autoDismissMs?: number;
}

export function CommitToast({
  commit,
  onOpen,
  onDismiss,
  autoDismissMs = AUTO_DISMISS_MS,
}: CommitToastProps) {
  const reducedMotion = useReducedMotion();
  const remaining = useRef(autoDismissMs);
  const armedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const pause = useCallback(() => {
    if (timer.current === undefined) return;
    clearTimeout(timer.current);
    timer.current = undefined;
    remaining.current = Math.max(0, remaining.current - (Date.now() - armedAt.current));
  }, []);

  const arm = useCallback(() => {
    armedAt.current = Date.now();
    timer.current = setTimeout(onDismiss, Math.max(remaining.current, 1000));
  }, [onDismiss]);

  useEffect(() => {
    arm();
    return () => clearTimeout(timer.current);
  }, [arm]);

  return (
    <motion.div
      layout={!reducedMotion}
      // No role="status" here — the viewport container is the live region
      // (m5); doubling live semantics makes some screen readers announce twice.
      // Causality (05 §5): slides in from the chat that caused it (the left).
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -20, y: 8 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98 }}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      onMouseEnter={pause}
      onMouseLeave={arm}
      onFocus={pause}
      onBlur={arm}
      className="pointer-events-auto w-[360px]"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen();
          }
        }}
        aria-label={`Memory commit ${commitBadge(commit)}: ${commit.headline}. Open diff.`}
        className="w-full cursor-pointer rounded-lg border bg-surface p-4 text-left shadow-overlay transition-colors duration-150 hover:border-primary/50"
      >
        <div className="flex items-center gap-2">
          <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-caption text-primary-legible">
            {commitBadge(commit)}
          </span>
          <span className="flex items-center gap-1 font-mono text-caption text-muted-foreground">
            <GitCommitHorizontal className="size-3.5" aria-hidden />
            {shortSha(commit.sha)}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Dismiss"
            onClick={(event) => {
              event.stopPropagation();
              onDismiss();
            }}
            // Negative margins keep the toast header visually compact while the
            // clickable box meets the 05 §9 ≥40px target.
            className="-my-2 -mr-2 flex size-10 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>

        <p className="mt-2 text-body-sm font-medium leading-snug">{commit.headline}</p>

        {commit.deltas.length > 0 ? (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {commit.deltas.slice(0, MAX_DELTA_CHIPS).map((delta, index) => (
              <DeltaTickChip
                key={delta.concept}
                concept={delta.concept}
                from={delta.from}
                to={delta.to}
                delayMs={200 + index * 120}
              />
            ))}
            {commit.deltas.length > MAX_DELTA_CHIPS ? (
              <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
                +{commit.deltas.length - MAX_DELTA_CHIPS} more
              </span>
            ) : null}
          </div>
        ) : null}

        <p className="mt-2 font-mono text-caption text-muted-foreground">
          {formatDiffStats(commit.stats)} · click to view diff
        </p>
      </div>
    </motion.div>
  );
}
