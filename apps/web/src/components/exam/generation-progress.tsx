'use client';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'motion/react';
import type { ExamDto } from '@eduagent/shared';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/use-dashboard';
import { useTurnStream, type ActivityChip } from '@/hooks/use-turn-stream';
import { getMemoryLog } from '@/lib/api';
import { formatMastery } from '@/lib/mastery';
import { cn } from '@/lib/utils';

/**
 * The exam generation screen (plans/05 §6.4): a terminal-styled card whose
 * mono lines are LIVE data — the real commit count from /api/memory/log, the
 * track's real weakest concepts, and the generation turn's activity events
 * streamed off the forked exam thread's socket. Never hardcoded counts. It's
 * a loading screen that demos the architecture.
 */

export interface TerminalLine {
  id: string;
  text: string;
  status: 'done' | 'running' | 'failed';
  /** The `$ command` line renders without the arrow prefix. */
  command?: boolean;
}

function chipLine(chip: ActivityChip): TerminalLine {
  return {
    id: chip.id,
    text: chip.label,
    status: chip.status === 'started' ? 'running' : chip.status === 'failed' ? 'failed' : 'done',
  };
}

function LineDots() {
  return (
    <span className="chip-dots" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}

export function TerminalCard({
  title,
  lines,
  failureMessage,
}: {
  title: string;
  lines: TerminalLine[];
  failureMessage: string | null;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <div className="overflow-hidden rounded-lg border bg-background shadow-overlay">
      <div className="flex items-center gap-2 border-b bg-surface px-4 py-2.5">
        <span className="flex gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-surface-2" />
          <span className="size-2.5 rounded-full bg-surface-2" />
          <span className="size-2.5 rounded-full bg-surface-2" />
        </span>
        <span className="font-mono text-caption text-muted-foreground">{title}</span>
      </div>
      <div
        className="flex flex-col gap-1.5 p-5 font-mono text-body-sm leading-relaxed"
        aria-live="polite"
      >
        {lines.map((line) => (
          <motion.p
            key={line.id}
            initial={reducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className={cn(
              'flex items-baseline gap-2',
              line.command ? 'text-foreground' : 'text-muted-foreground',
              line.status === 'failed' && 'text-danger',
            )}
          >
            <span aria-hidden className={cn('shrink-0', line.command ? 'text-primary' : '')}>
              {line.command ? '$' : line.status === 'failed' ? '✗' : '→'}
            </span>
            <span className="min-w-0 break-words">{line.text}</span>
            {line.status === 'running' ? <LineDots /> : null}
          </motion.p>
        ))}
        {failureMessage ? (
          <motion.p
            initial={reducedMotion ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-baseline gap-2 text-danger"
          >
            <span aria-hidden className="shrink-0">
              ✗
            </span>
            <span className="min-w-0 break-words">{failureMessage}</span>
          </motion.p>
        ) : (
          // The streaming caret — the one thing allowed to loop (plans/05 §5).
          <motion.span
            aria-hidden
            animate={reducedMotion ? undefined : { opacity: [1, 0.15, 1] }}
            transition={{ duration: 1.1, repeat: Infinity, ease: 'easeInOut' }}
            className="mt-0.5 inline-block h-4 w-2 bg-primary"
          />
        )}
      </div>
    </div>
  );
}

/** Mounted once the exam thread is resolved: streams its activity events. */
function LiveGeneration(props: {
  exam: ExamDto;
  threadId: string;
  failure: { message: string } | null;
}) {
  const { state } = useTurnStream(props.threadId);
  return (
    <GenerationBody
      exam={props.exam}
      liveLines={state.activityChips.map(chipLine)}
      failure={props.failure ?? (state.error ? { message: state.error.message } : null)}
    />
  );
}

function GenerationBody({
  exam,
  liveLines,
  failure,
}: {
  exam: ExamDto;
  liveLines: TerminalLine[];
  failure: { message: string } | null;
}) {
  const { data: dashboard } = useDashboard();
  // Real commit count — never hardcoded (plans/05 §6.4). 500 caps the fetch.
  const logQuery = useQuery({
    queryKey: ['memory', 'log', 'fork-count'],
    queryFn: ({ signal }) => getMemoryLog({ limit: 500 }, signal),
    staleTime: 60_000,
  });

  const commitCount = logQuery.data?.commits.length;
  const targeting = dashboard?.readiness.find((entry) => entry.track === exam.trackSlug)?.weakest;

  const introLines: TerminalLine[] = [
    {
      id: 'cmd',
      text: `eduagent exam fork --track ${exam.trackSlug} --duration ${exam.durationMin}m`,
      status: 'done',
      command: true,
    },
    commitCount === undefined
      ? { id: 'fork', text: 'forking your memory…', status: 'running' }
      : {
          id: 'fork',
          text: `forked from your memory (${commitCount}${commitCount === 500 ? '+' : ''} commits)`,
          status: 'done',
        },
    ...(targeting && targeting.length > 0
      ? [
          {
            id: 'target',
            text: `targeting your weakest: ${targeting
              .map(({ concept, effective }) => `${concept} ${formatMastery(effective)}`)
              .join(' · ')}`,
            status: 'done' as const,
          },
        ]
      : []),
  ];

  const failureMessage = failure?.message ?? null;
  // Before the first activity event lands there is still never a dead
  // spinner (plans/05 §6.3): a running line plus the blinking caret.
  const tailLines: TerminalLine[] =
    liveLines.length === 0 && failureMessage === null
      ? [{ id: 'writing', text: 'the examiner is reading your history…', status: 'running' }]
      : liveLines;
  return (
    <div className="flex w-full max-w-xl flex-col gap-5">
      <TerminalCard
        title={`exam-generator — forked thread · ${exam.trackSlug}`}
        lines={[...introLines, ...tailLines]}
        failureMessage={failureMessage}
      />
      {failureMessage ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border bg-surface p-5">
          <p className="text-body-sm text-muted-foreground">
            The examiner&apos;s generation turn died before it finished writing questions. Your
            memory is intact — a new exam forks it fresh.
          </p>
          <Button asChild>
            <Link href="/app/exam">Start a new exam</Link>
          </Button>
        </div>
      ) : (
        <p className="text-center font-display text-body italic text-muted-foreground">
          This wait is the feature: a second tutor just inherited your entire memory, and is
          writing questions only you would find hard.
        </p>
      )}
    </div>
  );
}

export function GenerationProgress({
  exam,
  threadId,
  failure,
}: {
  exam: ExamDto;
  /** The forked exam thread, once resolved — the live activity source. */
  threadId: string | null;
  /** Generation turn.error surfaced by the orchestrator (user socket). */
  failure: { message: string } | null;
}) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      {threadId ? (
        <LiveGeneration exam={exam} threadId={threadId} failure={failure} />
      ) : (
        <GenerationBody exam={exam} liveLines={[]} failure={failure} />
      )}
    </div>
  );
}
