'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { Check, ChevronDown, Loader2, Play, RotateCcw } from 'lucide-react';
import type { TrackDetail } from '@eduagent/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useTrackDetail, useTrackSessions } from '@/hooks/use-tracks';
import { createTrackSession, retryTrackGeneration } from '@/lib/api';
import { formatRoadmapDate, roadmapDayState, type RoadmapDay } from '@/lib/tracks';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/shared/error-state';
import { GenerationScene } from './generation-scene';
import { cn } from '@/lib/utils';

const EASE = [0.2, 0.8, 0.2, 1] as const;

function DateWhisper({ text, initialText }: { text: string; initialText?: string }) {
  const reducedMotion = useReducedMotion();
  const [shown, setShown] = useState(initialText ?? text);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (shown === text) return;
    if (reducedMotion) {
      setShown(text);
      return;
    }
    setVisible(false);
    let frame = 0;
    const swap = setTimeout(() => {
      setShown(text);
      frame = requestAnimationFrame(() => setVisible(true));
    }, 100);
    return () => {
      clearTimeout(swap);
      cancelAnimationFrame(frame);
    };
  }, [reducedMotion, shown, text]);

  return (
    <span
      className={cn(
        'font-mono text-caption text-muted-foreground transition-opacity duration-100',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {shown}
    </span>
  );
}

export function RoadmapHeader({
  detail,
  active = 'roadmap',
}: {
  detail: TrackDetail;
  active?: 'roadmap' | 'progress';
}) {
  const roadmap = detail.roadmap!;
  const total = roadmap.days.length;
  const completed = detail.completedDays.length;
  const lastDate = [...roadmap.days].reverse().find((day) => day.plannedDate)?.plannedDate ?? null;
  const finish = formatRoadmapDate(lastDate)?.replace(/^[A-Za-z]{3}, /, '') ?? '—';
  return (
    <header className="sticky top-0 z-10 border-b bg-background/95 px-5 py-4 backdrop-blur lg:px-8">
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate font-display text-h2 font-medium tracking-tight">
              {detail.title}
            </h1>
            <p className="font-mono text-caption text-muted-foreground">
              {detail.headDay === null
                ? `complete · ${detail.subtopicsDone}/${detail.subtopicsTotal} subtopics`
                : `day ${detail.headDay} of ${total} · ${detail.subtopicsDone}/${detail.subtopicsTotal} subtopics · penciled to finish ${finish}`}
            </p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/app/exam?track=${detail.slug}`}>Mock exam</Link>
          </Button>
        </div>
        <div
          role="meter"
          aria-label="Roadmap progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          className="h-1.5 overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${total === 0 ? 0 : (completed / total) * 100}%` }}
          />
        </div>
        <nav aria-label="Track views" className="flex gap-5 font-mono text-caption">
          <Link
            href={`/app/tracks/${detail.slug}`}
            className={cn(
              'py-1',
              active === 'roadmap'
                ? 'border-b-2 border-primary text-primary-legible'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Roadmap
          </Link>
          <Link
            href={`/app/tracks/${detail.slug}/progress`}
            className={cn(
              'py-1',
              active === 'progress'
                ? 'border-b-2 border-primary text-primary-legible'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Progress
          </Link>
        </nav>
      </div>
    </header>
  );
}

function DayDot({
  state,
  animateCompletion,
}: {
  state: ReturnType<typeof roadmapDayState>;
  animateCompletion: boolean;
}) {
  const reducedMotion = useReducedMotion();
  if (state === 'complete') {
    return (
      <motion.span
        initial={animateCompletion && !reducedMotion ? { scale: 1 } : false}
        animate={animateCompletion && !reducedMotion ? { scale: [1, 1.15, 1] } : { scale: 1 }}
        transition={{ type: 'spring', stiffness: 500, damping: 22 }}
        className="flex size-5 items-center justify-center rounded-full border-2 border-success bg-success text-background"
      >
        <svg viewBox="0 0 16 16" className="size-3" aria-hidden>
          <motion.path
            d="M3 8.2 6.5 11.5 13 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={animateCompletion && !reducedMotion ? { pathLength: 0 } : false}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.3, ease: EASE }}
          />
        </svg>
      </motion.span>
    );
  }
  if (state === 'current' || state === 'in-progress') {
    return (
      <span className="size-5 rounded-full border-4 border-background bg-primary ring-2 ring-primary/50" />
    );
  }
  if (state === 'upcoming') {
    return <span className="size-4 rounded-full border-2 border-primary bg-background" />;
  }
  return <span className="size-4 rounded-full border-2 bg-background" />;
}

interface AdvancedBeat {
  from: number;
  to: number | null;
  previousDates?: Record<number, string | null>;
}

function DayCard({
  day,
  detail,
  index,
  latestThreadId,
  advanced,
  nodeOffsets,
}: {
  day: RoadmapDay;
  detail: TrackDetail;
  index: number;
  latestThreadId: string | null;
  advanced: AdvancedBeat | null;
  nodeOffsets: Map<number, number>;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const state = roadmapDayState(day, detail.headDay);
  const initiallyExpanded = state === 'current' || state === 'in-progress';
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [starting, setStarting] = useState(false);
  const whisper =
    state === 'current' || state === 'in-progress'
      ? 'penciled for today'
      : state === 'upcoming'
        ? 'up next'
        : state === 'locked'
          ? `after day ${Math.max(1, day.day - 1)}`
          : day.sessionCount > 0
            ? `${day.sessionCount} session${day.sessionCount === 1 ? '' : 's'}`
            : 'complete';
  const planned =
    state === 'upcoming' || state === 'locked' ? formatRoadmapDate(day.plannedDate) : null;
  const displayWhisper = planned ? `${whisper} · penciled for ${planned}` : whisper;
  const previousPlanned = formatRoadmapDate(advanced?.previousDates?.[day.day] ?? null);
  const initialWhisper = previousPlanned
    ? `${whisper} · penciled for ${previousPlanned}`
    : undefined;
  const isNewHead = advanced?.to === day.day;
  const headTravel =
    isNewHead && advanced
      ? (nodeOffsets.get(advanced.from) ?? 0) - (nodeOffsets.get(day.day) ?? 0)
      : 0;

  const start = (intent: 'teach' | 'revise' | 'mistakes' = 'teach') => {
    setStarting(true);
    createTrackSession(detail.slug, { day: day.day, intent })
      .then((thread) => {
        void queryClient.invalidateQueries({ queryKey: ['tracks', detail.slug, 'sessions'] });
        router.push(`/app/tracks/${detail.slug}/s/${thread.id}`);
      })
      .catch(() => setStarting(false));
  };

  return (
    <motion.div
      layout={!reducedMotion}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
      animate={index < 10 ? { opacity: 1, y: 0 } : undefined}
      whileInView={index >= 10 ? { opacity: 1, y: 0 } : undefined}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.22, ease: EASE, delay: index < 10 ? index * 0.05 : 0 }}
    >
      <Card
        className={cn(
          'gap-3 p-4 transition-colors duration-150',
          state === 'complete' && 'bg-surface/60 text-muted-foreground',
          state === 'in-progress' && 'border-l-4 border-l-primary',
          state === 'current' && 'border-primary/50',
          state === 'locked' && 'opacity-[0.55]',
        )}
      >
        <button
          type="button"
          className="flex min-h-10 w-full items-start gap-3 text-left"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="font-mono text-caption text-muted-foreground">
            day/{String(day.day).padStart(2, '0')}
          </span>
          <span className="min-w-0 flex-1 font-display text-lead font-medium text-foreground">
            {day.title}
          </span>
          <ChevronDown
            className={cn(
              'size-4 text-muted-foreground transition-transform duration-150',
              expanded && 'rotate-180',
            )}
            aria-hidden
          />
        </button>

        {state === 'current' || state === 'in-progress' ? (
          <motion.span
            key={`head-${day.day}-${headTravel}`}
            initial={isNewHead && !reducedMotion ? { y: headTravel, opacity: 0.7 } : false}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 500, damping: 22 }}
            className="w-fit rounded-full bg-accent-soft px-2 py-0.5 font-mono text-caption text-primary-legible"
          >
            HEAD
          </motion.span>
        ) : null}

        {expanded || state === 'current' || state === 'in-progress' || state === 'upcoming' ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {day.subtopics.map((subtopic) => (
                <span
                  key={subtopic}
                  className="inline-flex items-center gap-1 rounded-sm bg-surface-2 px-2 py-1 text-caption"
                >
                  {state === 'complete' ? (
                    <Check className="size-3 text-success" aria-hidden />
                  ) : null}
                  {subtopic}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <DateWhisper text={displayWhisper} initialText={initialWhisper} />
            </div>
            {state === 'current' ? (
              <Button disabled={starting} className="self-start" onClick={() => start('teach')}>
                {starting ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Play className="size-4" aria-hidden />
                )}
                Start Day {day.day}
              </Button>
            ) : null}
            {state === 'in-progress' ? (
              <div className="flex flex-wrap gap-2">
                {latestThreadId ? (
                  <Button asChild variant="ghost">
                    <Link href={`/app/tracks/${detail.slug}/s/${latestThreadId}`}>
                      Resume session
                    </Link>
                  </Button>
                ) : null}
                <Button variant="outline" disabled={starting} onClick={() => start('revise')}>
                  <RotateCcw className="size-4" aria-hidden />
                  Revise this topic
                </Button>
                <Button variant="outline" disabled={starting} onClick={() => start('mistakes')}>
                  Learn from my mistakes
                </Button>
              </div>
            ) : null}
          </div>
        ) : (
          <DateWhisper text={displayWhisper} initialText={initialWhisper} />
        )}
      </Card>
    </motion.div>
  );
}

export function Roadmap({ slug, born = false }: { slug: string; born?: boolean }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const detail = useTrackDetail(slug);
  const sessions = useTrackSessions(slug);
  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<number, HTMLDivElement>());
  const cachedBeat = useRef(
    queryClient.getQueryData<AdvancedBeat>(['tracks', slug, 'completion-beat']) ?? null,
  );
  const previousHead = useRef<number | null | undefined>(cachedBeat.current?.from);
  const [advanced, setAdvanced] = useState<AdvancedBeat | null>(cachedBeat.current);
  const [nodeOffsets, setNodeOffsets] = useState(new Map<number, number>());

  useEffect(() => {
    if (!born) return;
    const timer = setTimeout(() => router.replace(`/app/tracks/${slug}`), reducedMotion ? 50 : 700);
    return () => clearTimeout(timer);
  }, [born, reducedMotion, router, slug]);

  useEffect(() => {
    if (!cachedBeat.current) return;
    queryClient.removeQueries({ queryKey: ['tracks', slug, 'completion-beat'], exact: true });
  }, [queryClient, slug]);

  useEffect(() => {
    const next = detail.data?.headDay;
    if (next === undefined) return;
    if (previousHead.current !== undefined && previousHead.current !== next) {
      const from = previousHead.current ?? 1;
      setAdvanced((current) =>
        current?.from === from && current.to === next ? current : { from, to: next },
      );
    }
    previousHead.current = next;
  }, [detail.data?.headDay]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !detail.data?.roadmap) return;
    const measure = () => {
      const top = container.getBoundingClientRect().top;
      const offsets = new Map<number, number>();
      for (const [day, node] of nodeRefs.current) {
        const rect = node.getBoundingClientRect();
        offsets.set(day, rect.top - top + rect.height / 2);
      }
      setNodeOffsets(offsets);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const node of nodeRefs.current.values()) observer.observe(node);
    return () => observer.disconnect();
  }, [detail.data?.roadmap]);

  const latestByDay = useMemo(() => {
    const map = new Map<number, string>();
    for (const session of sessions.data?.sessions ?? []) {
      if (session.kind === 'thread' && !map.has(session.roadmapDay)) {
        map.set(session.roadmapDay, session.thread.id);
      }
    }
    return map;
  }, [sessions.data]);

  if (detail.isPending) {
    return <div className="m-8 h-96 animate-pulse rounded-lg border bg-surface" aria-hidden />;
  }
  if (detail.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="The roadmap can’t load yet"
          description="Your committed plan is intact. Retry reads the same track again."
          onRetry={() => void detail.refetch()}
        />
      </div>
    );
  }
  if (detail.data.status === 'generating' && detail.data.planThreadId) {
    return <GenerationScene slug={slug} planThreadId={detail.data.planThreadId} />;
  }
  if (detail.data.status === 'failed') {
    if (detail.data.planThreadId) {
      return <GenerationScene slug={slug} planThreadId={detail.data.planThreadId} />;
    }
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="The roadmap draft needs another pass"
          description="Your memory is intact. Retry continues with the same track."
          onRetry={() => {
            retryTrackGeneration(slug).then(() => void detail.refetch());
          }}
          secondary={
            <Button asChild variant="ghost">
              <Link href="/app">Back to tracks</Link>
            </Button>
          }
        />
      </div>
    );
  }
  if (!detail.data.roadmap) return null;

  const days = detail.data.roadmap.days;
  const firstOffset = nodeOffsets.get(days[0]?.day ?? 1) ?? 18;
  const lastOffset = nodeOffsets.get(days.at(-1)?.day ?? 1) ?? firstOffset;
  const headOffset =
    detail.data.headDay === null
      ? lastOffset
      : (nodeOffsets.get(detail.data.headDay) ?? firstOffset);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <RoadmapHeader detail={detail.data} />
      <div ref={containerRef} className="relative mx-auto max-w-3xl px-4 py-8 sm:px-6">
        <svg
          aria-hidden
          className="pointer-events-none absolute left-[33px] top-0 h-full w-1 overflow-visible sm:left-[41px]"
          width="2"
        >
          <motion.line
            key={`progress-${advanced?.from ?? 'mount'}-${nodeOffsets.size}`}
            x1="1"
            x2="1"
            y1={firstOffset}
            y2={lastOffset}
            stroke="var(--border)"
            strokeWidth="2"
            initial={reducedMotion ? { opacity: 0 } : { pathLength: 0 }}
            animate={reducedMotion ? { opacity: 1 } : { pathLength: 1 }}
            transition={{ duration: 0.6, ease: EASE }}
          />
          <motion.line
            x1="1"
            x2="1"
            y1={firstOffset}
            initial={{
              y2: advanced ? (nodeOffsets.get(advanced.from) ?? firstOffset) : headOffset,
            }}
            animate={{ y2: headOffset }}
            stroke="var(--accent)"
            strokeWidth="2"
            transition={reducedMotion ? { duration: 0 } : { duration: 0.3, ease: EASE }}
          />
        </svg>

        <ol className="flex flex-col gap-4">
          {days.map((day, index) => {
            const state = roadmapDayState(day, detail.data.headDay);
            return (
              <li key={day.day} className="grid grid-cols-[36px_minmax(0,1fr)] items-start gap-3">
                <div
                  ref={(node) => {
                    if (node) nodeRefs.current.set(day.day, node);
                    else nodeRefs.current.delete(day.day);
                  }}
                  className="relative z-[1] flex min-h-12 items-start justify-center pt-3"
                >
                  <DayDot state={state} animateCompletion={advanced?.from === day.day} />
                </div>
                <DayCard
                  day={day}
                  detail={detail.data}
                  index={index}
                  latestThreadId={latestByDay.get(day.day) ?? null}
                  advanced={advanced}
                  nodeOffsets={nodeOffsets}
                />
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
