'use client';

import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Timer } from 'lucide-react';
import { formatClock, msRemaining, timerTone } from '@/lib/exam';
import { cn } from '@/lib/utils';

/**
 * The sticky countdown (plans/04 §6): counts to the SERVER's deadline
 * (startedAt + durationMin) — never a client-started clock. Calm → amber
 * under 5 minutes → red with a subtle pulse under 1 minute. The 30s server
 * grace is enforcement detail and never displayed.
 */

const TONE_CLASS = {
  calm: 'text-foreground',
  amber: 'text-warn',
  red: 'text-danger',
} as const;

/** Presentational — pure props, smoke-testable without a clock. */
export function TimerDisplay({ msLeft }: { msLeft: number }) {
  const reducedMotion = useReducedMotion();
  const tone = timerTone(msLeft);
  const clock = formatClock(msLeft);
  return (
    <motion.span
      role="timer"
      aria-label={`Time remaining ${clock}`}
      animate={
        tone === 'red' && !reducedMotion ? { opacity: [1, 0.55, 1] } : { opacity: 1 }
      }
      transition={
        tone === 'red' ? { duration: 1.2, repeat: Infinity, ease: 'easeInOut' } : undefined
      }
      className={cn(
        'inline-flex items-center gap-2 font-mono text-h4 font-semibold tabular-nums',
        TONE_CLASS[tone],
      )}
    >
      <Timer className="size-4.5" aria-hidden />
      <span className="numeric">{clock}</span>
    </motion.span>
  );
}

export function ExamTimer({
  deadlineMs,
  onExpire,
}: {
  deadlineMs: number;
  /** Fired once when the clock crosses zero. */
  onExpire: () => void;
}) {
  const [msLeft, setMsLeft] = useState(() => msRemaining(deadlineMs, Date.now()));
  const expiredRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  useEffect(() => {
    const tick = () => {
      const left = msRemaining(deadlineMs, Date.now());
      setMsLeft(left);
      if (left <= 0 && !expiredRef.current) {
        expiredRef.current = true;
        onExpireRef.current();
      }
    };
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [deadlineMs]);

  return <TimerDisplay msLeft={msLeft} />;
}
