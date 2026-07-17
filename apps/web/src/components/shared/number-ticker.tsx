'use client';

import { useEffect, useRef, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';

/**
 * Ticker motion class (plans/05 §5): 600–900ms ease-in-out count-ups, reused
 * by delta chips, DeltaBars, and (Phases 2–4) gauges and exam results.
 * Reduced motion jumps straight to the target value.
 */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export interface TickOptions {
  /** Starting value for the first animation (defaults to the target — no tick). */
  from?: number;
  durationMs?: number;
  delayMs?: number;
}

/** Animated number that follows `target`; drives both text and color sweeps. */
export function useTickedNumber(target: number, options?: TickOptions): number {
  const reducedMotion = useReducedMotion();
  const [value, setValue] = useState(options?.from ?? target);
  const valueRef = useRef(options?.from ?? target);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const from = valueRef.current;
    if (reducedMotion || from === target) {
      valueRef.current = target;
      setValue(target);
      return;
    }
    const duration = optionsRef.current?.durationMs ?? 750;
    const delay = optionsRef.current?.delayMs ?? 0;
    let raf = 0;
    let start: number | null = null;
    const timer = setTimeout(() => {
      const tick = (now: number) => {
        start ??= now;
        const t = Math.min(1, (now - start) / duration);
        const next = from + (target - from) * easeInOut(t);
        valueRef.current = next;
        setValue(next);
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, [target, reducedMotion]);

  return value;
}

interface NumberTickerProps extends TickOptions {
  value: number;
  decimals?: number;
  className?: string;
}

export function NumberTicker({
  value,
  from,
  durationMs,
  delayMs,
  decimals = 2,
  className,
}: NumberTickerProps) {
  const current = useTickedNumber(value, { from, durationMs, delayMs });
  return <span className={cn('numeric', className)}>{current.toFixed(decimals)}</span>;
}
