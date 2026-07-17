'use client';

import { motion, useReducedMotion } from 'motion/react';
import { GitCommitHorizontal } from 'lucide-react';
import type { AssessmentPayload, ConceptDelta } from '@eduagent/shared';
import { useTickedNumber } from '@/components/shared/number-ticker';
import { formatMastery, masteryColor } from '@/lib/mastery';

/**
 * Mastery ticker strip (plans/05 §6.2): when assessment.recorded lands, each
 * concept's number counts from→to (Ticker class) while a 2px underline sweeps
 * in the delta's direction color — green up, amber down. Same visual language
 * as the commit-toast delta chips.
 */
function AssessmentChip({ delta, delayMs }: { delta: ConceptDelta; delayMs: number }) {
  const reducedMotion = useReducedMotion();
  const current = useTickedNumber(delta.to, { from: delta.from, durationMs: 800, delayMs });
  const up = delta.to >= delta.from;
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={delta.to}
      aria-label={`${delta.concept} mastery ${formatMastery(delta.from)} to ${formatMastery(delta.to)}`}
      title={delta.evidence}
      className="inline-flex items-center gap-1.5 rounded-sm bg-surface-2 px-2 py-1 font-mono text-caption"
    >
      <span aria-hidden className="text-muted-foreground">
        {delta.concept}
      </span>
      <span aria-hidden className="relative numeric">
        <span className="text-muted-foreground">{formatMastery(delta.from)}→</span>
        <span style={{ color: masteryColor(current) }}>{formatMastery(current)}</span>
        <motion.span
          initial={reducedMotion ? { width: '100%' } : { width: 0 }}
          animate={{ width: '100%' }}
          transition={{ duration: 0.8, delay: delayMs / 1000, ease: 'easeInOut' }}
          className="absolute -bottom-0.5 left-0 h-0.5 rounded-full"
          style={{ backgroundColor: up ? 'var(--success)' : 'var(--warn)' }}
        />
      </span>
    </span>
  );
}

interface AssessmentStripProps {
  assessment: AssessmentPayload | null;
  /** Bumps per assessment.recorded — keys the strip so tickers re-run. */
  seq: number;
}

export function AssessmentStrip({ assessment, seq }: AssessmentStripProps) {
  if (!assessment || assessment.concept_deltas.length === 0) return null;
  return (
    <motion.div
      key={seq}
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      aria-live="polite"
      aria-label="Assessment recorded"
      className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-surface-2/40 px-4 py-2"
    >
      <span className="flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
        <GitCommitHorizontal className="size-3.5" aria-hidden />
        assessed
      </span>
      {assessment.concept_deltas.map((delta, index) => (
        <AssessmentChip
          key={`${seq}:${delta.topic}/${delta.concept}`}
          delta={delta}
          delayMs={150 + index * 120}
        />
      ))}
    </motion.div>
  );
}
