'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { Leaf, Loader2 } from 'lucide-react';
import type { DashboardData } from '@eduagent/shared';
import { MasteryBar } from '@/components/shared/mastery-bar';
import { Button } from '@/components/ui/button';
import { createThread } from '@/lib/api';
import { formatShortDate } from '@/lib/dashboard-data';
import { formatMastery, masteryColor } from '@/lib/mastery';
import { cn } from '@/lib/utils';

/**
 * Mastery heatmap (plans/04 §4, 05 §7): 28px cells, 4px gap, 6px radius,
 * grouped by topic with a topic-average bar. Fill = effective mastery on the
 * ramp; fading = amber overlay at 35% + decay glyph — NEVER a hue shift
 * (colorblind-safe). Hover card shows raw vs effective + last assessed;
 * click opens the concept popover (Review now / Learn more).
 */
type Topic = DashboardData['topics'][number];
type Concept = Topic['concepts'][number];

function ConceptHoverCard({ concept }: { concept: Concept }) {
  return (
    <div className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-56 -translate-x-1/2 rounded-md border bg-popover p-3 text-left shadow-overlay">
      <p className="text-body-sm font-medium leading-snug">{concept.name}</p>
      <dl className="mt-2 flex flex-col gap-1 font-mono text-caption text-muted-foreground">
        <div className="flex justify-between gap-3">
          <dt>mastery</dt>
          <dd className="numeric text-foreground">{formatMastery(concept.mastery)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>effective</dt>
          <dd className="numeric" style={{ color: masteryColor(concept.effective) }}>
            {formatMastery(concept.effective)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>last assessed</dt>
          <dd>{formatShortDate(concept.lastAssessed)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt>reviews</dt>
          <dd className="numeric">{concept.reviewCount}</dd>
        </div>
      </dl>
      {concept.fading ? (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-warn">
          <Leaf className="size-3" aria-hidden />
          fading — effective slipped below mastery
        </p>
      ) : null}
    </div>
  );
}

function ConceptPopover({
  topic,
  concept,
  onClose,
}: {
  topic: Topic;
  concept: Concept;
  onClose: () => void;
}) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const learnMore = async () => {
    setBusy(true);
    try {
      const thread = await createThread({ mode: 'learn', topicSlug: topic.topic });
      router.push(`/app/learn/${thread.id}`);
    } catch {
      setBusy(false);
      router.push('/app/learn');
    }
  };

  return (
    <motion.div
      ref={ref}
      role="dialog"
      aria-label={`${concept.name} actions`}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}
      className="absolute left-1/2 top-full z-30 mt-2 w-64 -translate-x-1/2 rounded-md border bg-popover p-4 shadow-overlay"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-body-sm font-medium">{concept.name}</p>
        {concept.fading ? (
          <span className="flex items-center gap-1 font-mono text-caption text-warn">
            <Leaf className="size-3" aria-hidden />
            fading
          </span>
        ) : null}
      </div>
      <p className="numeric mt-1 font-mono text-caption text-muted-foreground">
        {formatMastery(concept.mastery)} raw ·{' '}
        <span style={{ color: masteryColor(concept.effective) }}>
          {formatMastery(concept.effective)}
        </span>{' '}
        effective
      </p>
      <MasteryBar
        value={concept.effective}
        className="mt-2.5"
        aria-label={`${concept.name} effective mastery`}
      />
      <div className="mt-3.5 flex gap-2">
        <Button asChild size="sm" className="flex-1">
          <Link href="/app/review">Review now</Link>
        </Button>
        <Button size="sm" variant="outline" className="flex-1 gap-1.5" disabled={busy} onClick={() => void learnMore()}>
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Learn more
        </Button>
      </div>
    </motion.div>
  );
}

function ConceptCell({
  topic,
  concept,
  open,
  onToggle,
}: {
  topic: Topic;
  concept: Concept;
  open: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`${concept.name}: mastery ${formatMastery(concept.mastery)}, effective ${formatMastery(concept.effective)}${concept.fading ? ', fading' : ''}`}
        aria-expanded={open}
        onClick={() => onToggle(!open)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className={cn(
          'relative block size-7 overflow-hidden rounded-[6px] transition-transform duration-150 hover:scale-110',
          open && 'ring-2 ring-ring ring-offset-2 ring-offset-surface',
        )}
        style={{ backgroundColor: masteryColor(concept.effective) }}
      >
        {concept.fading ? (
          <>
            {/* Amber overlay at 35%, pulsing (05 §5) — the ramp color beneath never shifts. */}
            <span aria-hidden className="fading-pulse absolute inset-0 bg-warn" style={{ opacity: 0.35 }} />
            <Leaf aria-hidden className="absolute right-0.5 top-0.5 size-2.5 text-warn drop-shadow" />
          </>
        ) : null}
      </button>
      {hovered && !open ? <ConceptHoverCard concept={concept} /> : null}
      <AnimatePresence>
        {open ? (
          <ConceptPopover topic={topic} concept={concept} onClose={() => onToggle(false)} />
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function MasteryHeatmap({ topics }: { topics: DashboardData['topics'] }) {
  const [openCell, setOpenCell] = useState<string | null>(null);

  return (
    <section aria-label="Mastery heatmap" className="flex flex-col gap-5 rounded-lg border bg-surface p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lead font-medium">Mastery</h2>
        <p className="flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
          <Leaf className="size-3 text-warn" aria-hidden />
          = fading
        </p>
      </header>

      {topics.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-body-sm text-muted-foreground">
            Every concept you touch gets a mastery score — one cell per concept, filled from your
            commits (e.g. <span className="font-mono text-caption">left-join 0.62</span>).
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href="/app/learn">Start learning</Link>
          </Button>
        </div>
      ) : null}

      {topics.map((topic) => {
        const avg =
          topic.concepts.length > 0
            ? topic.concepts.reduce((sum, c) => sum + c.effective, 0) / topic.concepts.length
            : 0;
        return (
          <div key={topic.topic} className="flex flex-col gap-2.5">
            <div className="flex items-center gap-3">
              <h3 className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
                {topic.displayName}
              </h3>
              <MasteryBar
                value={avg}
                className="max-w-32"
                aria-label={`${topic.displayName} average effective mastery`}
              />
              <span className="numeric font-mono text-caption text-muted-foreground">
                {formatMastery(avg)}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {topic.concepts.map((concept) => {
                const key = `${topic.topic}/${concept.id}`;
                return (
                  <ConceptCell
                    key={key}
                    topic={topic}
                    concept={concept}
                    open={openCell === key}
                    onToggle={(open) => setOpenCell(open ? key : null)}
                  />
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}
