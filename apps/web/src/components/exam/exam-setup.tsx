'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, GitFork, GraduationCap, Loader2, Timer } from 'lucide-react';
import type { DashboardData, ExamStatus, ExamSummary } from '@eduagent/shared';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useDashboard } from '@/hooks/use-dashboard';
import { createExam, listExams } from '@/lib/api';
import { formatRelativeTime } from '@/lib/dashboard-data';
import { EXAM_STATUS_LABEL } from '@/lib/exam';
import { formatMastery, masteryColor } from '@/lib/mastery';
import { cn } from '@/lib/utils';

/**
 * Exam setup + history (plans/04 §6): track selector with live readiness,
 * duration picker, and the targeting panel — transparent about what the
 * examiner will aim at (the track's weakest concepts, the dashboard's own
 * numbers). Creating an exam fires POST /api/exams and routes straight into
 * the generation screen at /app/exam/:id.
 */

const DURATIONS_MIN = [15, 30, 60] as const;

type Readiness = DashboardData['readiness'][number];

const STATUS_VARIANT: Record<ExamStatus, 'secondary' | 'accent' | 'warn' | 'success'> = {
  draft: 'secondary',
  ready: 'accent',
  in_progress: 'warn',
  submitted: 'warn',
  graded: 'success',
};

function TrackOption({
  track,
  selected,
  onSelect,
}: {
  track: Readiness;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'flex items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors duration-150',
        selected ? 'border-primary bg-accent-soft/40' : 'hover:border-primary/50 hover:bg-surface-2',
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-body font-medium">{track.displayName}</span>
        <span className="font-mono text-caption text-muted-foreground">{track.track}</span>
      </span>
      <span className="flex flex-col items-end gap-0.5">
        <span
          className="numeric text-h4 font-semibold"
          style={{ color: masteryColor(track.score / 100) }}
        >
          {Math.round(track.score)}
        </span>
        <span className="font-mono text-caption text-muted-foreground">readiness</span>
      </span>
    </button>
  );
}

function SetupCard({ readiness }: { readiness: Readiness[] }) {
  const router = useRouter();
  const [trackSlug, setTrackSlug] = useState(readiness[0]?.track ?? '');
  const [durationMin, setDurationMin] = useState<number>(30);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const selected = readiness.find((entry) => entry.track === trackSlug) ?? readiness[0];

  const create = async () => {
    if (!selected) return;
    setCreating(true);
    setCreateError(null);
    try {
      const { examId } = await createExam({ trackSlug: selected.track, durationMin });
      router.push(`/app/exam/${examId}`);
    } catch (err) {
      setCreating(false);
      setCreateError(err instanceof Error ? err.message : 'Creating the exam failed.');
    }
  };

  return (
    <section
      aria-label="Exam setup"
      className="flex flex-col gap-5 rounded-lg border bg-surface p-6"
    >
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-h3 font-medium">Fork your memory into an exam.</h2>
        <p className="text-body-sm text-muted-foreground">
          The examiner inherits everything EduAgent knows about you, then writes a timed exam
          aimed at exactly what you&apos;re weakest at.
        </p>
      </div>

      <div className="flex flex-col gap-2" role="radiogroup" aria-label="Track">
        <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
          track
        </p>
        {readiness.map((track) => (
          <TrackOption
            key={track.track}
            track={track}
            selected={track.track === selected?.track}
            onSelect={() => setTrackSlug(track.track)}
          />
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
          duration
        </p>
        <div className="flex gap-2" role="radiogroup" aria-label="Duration">
          {DURATIONS_MIN.map((minutes) => (
            <button
              key={minutes}
              type="button"
              role="radio"
              aria-checked={durationMin === minutes}
              onClick={() => setDurationMin(minutes)}
              className={cn(
                'flex-1 rounded-md border px-3 py-2.5 font-mono text-body-sm transition-colors duration-150',
                durationMin === minutes
                  ? 'border-primary bg-accent-soft/40 text-foreground'
                  : 'text-muted-foreground hover:border-primary/50 hover:bg-surface-2',
              )}
            >
              <span className="numeric">{minutes}</span> min
            </button>
          ))}
        </div>
      </div>

      {selected && selected.weakest.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed bg-surface-2/40 p-4">
          <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
            what it targets
          </p>
          <div className="flex flex-wrap gap-1.5">
            {selected.weakest.map(({ concept, name, effective }) => (
              <span
                key={concept}
                title={`${name} — effective mastery ${formatMastery(effective)}`}
                className="inline-flex items-center gap-1.5 rounded-sm border bg-surface px-2 py-1 font-mono text-caption"
              >
                <span
                  aria-hidden
                  className="size-2 rounded-full"
                  style={{ backgroundColor: masteryColor(effective) }}
                />
                {concept}
                <span className="numeric text-muted-foreground">{formatMastery(effective)}</span>
              </span>
            ))}
          </div>
          <p className="text-caption text-muted-foreground">
            Your {selected.weakest.length} weakest concepts by live mastery — the same numbers on
            your dashboard. No secrets about where it will press.
          </p>
        </div>
      ) : null}

      <Button size="lg" className="gap-2" disabled={creating || !selected} onClick={() => void create()}>
        {creating ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <GitFork className="size-4" aria-hidden />
        )}
        {creating ? 'Forking your memory…' : 'Fork my memory into an exam'}
      </Button>
      {createError ? (
        <p role="alert" className="text-body-sm text-danger">
          {createError}
        </p>
      ) : null}
    </section>
  );
}

function HistoryRow({ exam }: { exam: ExamSummary }) {
  const graded = exam.status === 'graded';
  return (
    <li>
      <Link
        href={`/app/exam/${exam.id}`}
        className="group flex items-center gap-3 rounded-lg border bg-surface px-4 py-3 transition-colors duration-150 hover:border-primary/50"
      >
        <Badge variant={STATUS_VARIANT[exam.status]} className="font-mono lowercase">
          {EXAM_STATUS_LABEL[exam.status]}
        </Badge>
        <span className="min-w-0 flex-1 truncate font-mono text-body-sm">{exam.trackSlug}</span>
        <span className="flex items-center gap-1 font-mono text-caption text-muted-foreground">
          <Timer className="size-3" aria-hidden />
          <span className="numeric">{exam.durationMin}</span>m
        </span>
        <span className="font-mono text-caption text-muted-foreground">
          {formatRelativeTime(exam.createdAt)}
        </span>
        <span className="flex items-center gap-1 text-caption font-medium text-primary opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {graded ? 'results' : 'open'}
          <ArrowRight className="size-3" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

function History() {
  const examsQuery = useQuery({
    queryKey: ['exams'],
    queryFn: ({ signal }) => listExams(signal),
  });

  return (
    <section aria-label="Exam history" className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lead font-medium">History</h2>
        {examsQuery.data ? (
          <p className="font-mono text-caption text-muted-foreground">
            <span className="numeric">{examsQuery.data.exams.length}</span> exams
          </p>
        ) : null}
      </header>

      {examsQuery.isPending ? (
        <div className="flex animate-pulse flex-col gap-2" aria-hidden>
          <div className="h-12 rounded-lg border bg-surface" />
          <div className="h-12 rounded-lg border bg-surface" />
        </div>
      ) : examsQuery.isError ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border bg-surface p-4">
          <p className="text-body-sm text-muted-foreground">The exam history didn&apos;t load.</p>
          <Button size="sm" variant="outline" onClick={() => void examsQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : examsQuery.data.exams.length === 0 ? (
        <p className="rounded-lg border border-dashed bg-surface/50 p-4 text-body-sm text-muted-foreground">
          No exams yet — your first sitting lands here, results and all.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {examsQuery.data.exams.map((exam) => (
            <HistoryRow key={exam.id} exam={exam} />
          ))}
        </ul>
      )}
    </section>
  );
}

export function ExamSetup() {
  const dashboardQuery = useDashboard();

  if (dashboardQuery.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-2xl animate-pulse flex-col gap-4 p-8" aria-hidden>
        <div className="h-96 rounded-lg border bg-surface" />
        <div className="h-24 rounded-lg border bg-surface" />
      </div>
    );
  }

  if (dashboardQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="The exam setup can't load"
          description="Readiness and targeting come from your memory via the agent host, and it didn't answer."
          detail={dashboardQuery.error instanceof Error ? dashboardQuery.error.message : undefined}
          onRetry={() => void dashboardQuery.refetch()}
        />
      </div>
    );
  }

  const readiness = dashboardQuery.data.readiness;

  if (readiness.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={GraduationCap}
          title="No track to examine yet."
          description="Exams are forked from your memory, and your memory doesn't have a track with readiness yet. A learning session plants one."
          example="→ forked from your memory · targeting your weakest concepts"
          cta={{ label: 'Start learning', href: '/app/learn' }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-8">
      <SetupCard readiness={readiness} />
      <History />
    </div>
  );
}
