'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Loader2, Timer } from 'lucide-react';
import type { DashboardData } from '@eduagent/shared';
import { useTickedNumber } from '@/components/shared/number-ticker';
import { Button } from '@/components/ui/button';
import { createThread } from '@/lib/api';
import { daysUntil, formatShortDate } from '@/lib/dashboard-data';
import { formatMastery, masteryColor } from '@/lib/mastery';
import { cn } from '@/lib/utils';

/**
 * ReadinessGauge card (plans/04 §4, 05 §7): 270° radial, thick stroke,
 * needle-free; center = big tabular score + 7d delta pill. Below: target
 * countdown, weakest-concept chips (click → learn session), mock-exam CTA.
 */
type Readiness = DashboardData['readiness'][number];

const SIZE = 168;
const STROKE = 16;
const RADIUS = (SIZE - STROKE) / 2;
const SPAN_DEG = 270;

/** Point on the gauge circle; 0° = top, positive clockwise. */
function polar(angleDeg: number): { x: number; y: number } {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: SIZE / 2 + RADIUS * Math.cos(rad), y: SIZE / 2 + RADIUS * Math.sin(rad) };
}

/** SVG arc path from -135° clockwise across `deg` of the 270° span. */
function arcPath(deg: number): string {
  const clamped = Math.min(SPAN_DEG - 0.001, Math.max(0.001, deg));
  const start = polar(-SPAN_DEG / 2);
  const end = polar(-SPAN_DEG / 2 + clamped);
  const largeArc = clamped > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${RADIUS} ${RADIUS} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

function GaugeDial({ score }: { score: number }) {
  const ticked = useTickedNumber(score, { from: 0, durationMs: 900 });
  const color = masteryColor(ticked / 100);
  return (
    <div className="relative" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} aria-hidden>
        <path
          d={arcPath(SPAN_DEG)}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
        <path
          d={arcPath((ticked / 100) * SPAN_DEG)}
          fill="none"
          stroke={color}
          strokeWidth={STROKE}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="numeric font-display text-display leading-none" style={{ color }}>
          {Math.round(ticked)}
        </span>
        <span className="mt-1 font-mono text-caption text-muted-foreground">/ 100</span>
      </div>
    </div>
  );
}

function DeltaPill({ delta7d }: { delta7d: number }) {
  const up = delta7d >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-caption font-medium',
        up ? 'bg-success/15 text-success' : 'bg-warn/15 text-warn',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="numeric">
        {up ? '+' : '−'}
        {Math.abs(delta7d).toFixed(1)}
      </span>
      <span className="text-[0.7rem] opacity-80">7d</span>
    </span>
  );
}

export function ReadinessGauge({
  readiness,
  today,
  conceptTopic,
}: {
  readiness: Readiness;
  /** Today in the learner's timezone (activity strip's last entry). */
  today: string;
  /** concept slug → topic slug, for the weakest-chip learn links. */
  conceptTopic: Map<string, string>;
}) {
  const router = useRouter();
  const [busyConcept, setBusyConcept] = useState<string | null>(null);

  const startLearn = async (concept: string) => {
    const topicSlug = conceptTopic.get(concept);
    if (!topicSlug) {
      router.push('/app/learn');
      return;
    }
    setBusyConcept(concept);
    try {
      const thread = await createThread({ mode: 'learn', topicSlug });
      router.push(`/app/learn/${thread.id}`);
    } catch {
      setBusyConcept(null);
      router.push('/app/learn');
    }
  };

  const targetDays = readiness.targetDate ? daysUntil(readiness.targetDate, today) : null;

  return (
    <section
      aria-label={`${readiness.displayName} readiness`}
      className="flex flex-col gap-4 rounded-lg border bg-surface p-6"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-lead font-medium">{readiness.displayName}</h2>
          <p className="font-mono text-caption text-muted-foreground">{readiness.track}</p>
        </div>
        <DeltaPill delta7d={readiness.delta7d} />
      </header>

      <div className="flex flex-col items-center gap-1">
        <GaugeDial score={readiness.score} />
        {readiness.targetDate && targetDays !== null ? (
          <p className="flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
            <Timer className="size-3.5" aria-hidden />
            {targetDays > 0
              ? `${targetDays} days to target · ${formatShortDate(readiness.targetDate)}`
              : `target date ${formatShortDate(readiness.targetDate)} passed`}
          </p>
        ) : null}
      </div>

      {readiness.weakest.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground/80">
            weakest concepts
          </p>
          <div className="flex flex-wrap gap-1.5">
            {readiness.weakest.map(({ concept, name, effective }) => (
              <button
                key={concept}
                type="button"
                disabled={busyConcept !== null}
                onClick={() => void startLearn(concept)}
                title={`Start a learn session on ${name} (effective ${formatMastery(effective)})`}
                className="group inline-flex items-center gap-1.5 rounded-sm border bg-surface-2/60 px-2 py-1 font-mono text-caption transition-colors duration-150 hover:border-primary/50 hover:text-foreground disabled:opacity-60"
              >
                {busyConcept === concept ? (
                  <Loader2 className="size-3 animate-spin text-primary" aria-hidden />
                ) : (
                  <span
                    aria-hidden
                    className="size-2 rounded-full"
                    style={{ backgroundColor: masteryColor(effective) }}
                  />
                )}
                {concept}
                <span className="numeric text-muted-foreground">{formatMastery(effective)}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <Button asChild variant="outline" className="mt-auto w-full">
        <Link href="/app/exam">Take a mock exam</Link>
      </Button>
    </section>
  );
}
