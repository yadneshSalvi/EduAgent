'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Check, PenLine, Terminal, X } from 'lucide-react';
import type { ActivityChip } from '@/hooks/use-turn-stream';
import { cn } from '@/lib/utils';

/**
 * Activity chips (plans/05 §6.3): pill + 3-dot pulse while running ("⚙ running
 * tests"), ✓ pop (Micro) on completion, fade 2s later. The agent must always
 * feel busy on your behalf — never a dead spinner.
 */
const SETTLED_LINGER_MS = 2000;

function Dots() {
  return (
    <span className="chip-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

function Chip({ chip }: { chip: ActivityChip }) {
  const reducedMotion = useReducedMotion();
  const Icon = chip.kind === 'exec' ? Terminal : PenLine;
  return (
    <motion.span
      layout={!reducedMotion}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border bg-surface-2 py-1 pl-2.5 pr-3 font-mono text-caption',
        chip.status === 'failed' ? 'text-danger' : 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span>{chip.label}</span>
      {chip.status === 'started' ? <Dots /> : null}
      {chip.status === 'completed' ? (
        <motion.span
          initial={reducedMotion ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 22 }}
          className="text-success"
        >
          <Check className="size-3.5" aria-hidden />
        </motion.span>
      ) : null}
      {chip.status === 'failed' ? <X className="size-3.5" aria-hidden /> : null}
    </motion.span>
  );
}

export function ActivityChips({ chips }: { chips: ActivityChip[] }) {
  // Settled chips linger 2s, then leave via AnimatePresence.
  const settledAt = useRef(new Map<string, number>());
  const [, forceTick] = useState(0);

  const now = Date.now();
  for (const chip of chips) {
    if (chip.status !== 'started' && !settledAt.current.has(chip.id)) {
      settledAt.current.set(chip.id, now);
    }
  }
  const visible = chips.filter((chip) => {
    if (chip.status === 'started') return true;
    const at = settledAt.current.get(chip.id) ?? now;
    return now - at < SETTLED_LINGER_MS;
  });

  const hasLingering = visible.some((chip) => chip.status !== 'started');
  useEffect(() => {
    if (!hasLingering) return;
    const timer = setInterval(() => forceTick((n) => n + 1), 500);
    return () => clearInterval(timer);
  }, [hasLingering]);

  return (
    <AnimatePresence initial={false}>
      {visible.length > 0 ? (
        <motion.div
          key="chips"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex flex-wrap items-center gap-2"
          aria-live="polite"
          aria-label="Tutor activity"
        >
          <AnimatePresence initial={false}>
            {visible.map((chip) => (
              <Chip key={chip.id} chip={chip} />
            ))}
          </AnimatePresence>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
