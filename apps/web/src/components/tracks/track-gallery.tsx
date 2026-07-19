'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Flame, GitCommitHorizontal, Loader2, Plus, Route, RotateCcw } from 'lucide-react';
import type { DashboardData, TrackSummary } from '@eduagent/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useDashboard } from '@/hooks/use-dashboard';
import { useTracks } from '@/hooks/use-tracks';
import { useUserSocketEvents } from '@/components/memory/memory-commit-provider';
import { retryTrackGeneration } from '@/lib/api';
import { commitBadge } from '@/lib/commit-format';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { cn } from '@/lib/utils';

const GOAL_LABEL: Record<TrackSummary['goalType'], string> = {
  interview: 'Interview preparation',
  exam: 'Exam preparation',
  mastery: 'Build mastery',
  explore: 'Follow your curiosity',
};

function weekday(iso: string | null): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

/** Keep long roadmaps legible while always retaining the real HEAD node. */
export function sampledSparklineDays(total: number, head: number | null): number[] {
  if (total <= 30) return Array.from({ length: total }, (_, index) => index + 1);
  const sampled = new Set<number>();
  for (let index = 0; index < 30; index++) {
    sampled.add(Math.round((index * (total - 1)) / 29) + 1);
  }
  if (head !== null) sampled.add(head);
  if (sampled.size > 30 && head !== null) {
    const nearest = [...sampled]
      .filter((day) => day !== head && day !== 1 && day !== total)
      .sort((left, right) => Math.abs(left - head) - Math.abs(right - head))[0];
    if (nearest !== undefined) sampled.delete(nearest);
  }
  return [...sampled].sort((left, right) => left - right);
}

export function TrackSparkline({ track }: { track: TrackSummary }) {
  const total = track.day?.total ?? track.completedDays.length;
  if (total === 0) return null;
  const days = sampledSparklineDays(total, track.day?.head ?? null);
  const completed = new Set(track.completedDays);
  const gap = 10;
  return (
    <svg
      viewBox={`0 0 ${Math.max(4, (days.length - 1) * gap + 8)} 12`}
      className="h-4 w-full overflow-visible"
      role="img"
      aria-label={`${completed.size} of ${total} roadmap days complete`}
      preserveAspectRatio="xMinYMid meet"
    >
      {days.map((day, index) => {
        const isHead = track.day?.head === day;
        const isComplete = completed.has(day);
        return (
          <circle
            key={day}
            cx={index * gap + 4}
            cy="6"
            r={isHead ? 3.25 : 2.25}
            fill={isComplete ? 'var(--success)' : 'var(--surface)'}
            stroke={isHead ? 'var(--accent)' : isComplete ? 'var(--success)' : 'var(--border)'}
            strokeWidth={isHead ? 2 : 1.5}
          />
        );
      })}
    </svg>
  );
}

function TrackCard({ track, targetDate }: { track: TrackSummary; targetDate?: string }) {
  const queryClient = useQueryClient();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);

  if (track.status === 'generating') {
    return (
      <Link href={`/app/tracks/${track.slug}`} className="block" aria-label={`Open ${track.title}`}>
        <Card className="fading-pulse min-h-48 justify-center border-dashed">
          <span className="chip-dots text-primary" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <p className="font-display text-h4 font-medium">{track.title}</p>
          <p className="font-serif italic text-body-sm text-muted-foreground">
            Drafting your roadmap…
          </p>
        </Card>
      </Link>
    );
  }

  if (track.status === 'failed') {
    return (
      <Card className="min-h-48 border-danger/50">
        <div className="flex flex-col gap-1">
          <Link
            href={`/app/tracks/${track.slug}`}
            className="font-display text-h4 font-medium hover:text-primary"
          >
            {track.title}
          </Link>
          <p className="text-body-sm text-muted-foreground">The draft needs another pass.</p>
        </div>
        <Button
          variant="outline"
          className="self-start"
          disabled={retrying}
          onClick={() => {
            setRetrying(true);
            setRetryError(false);
            retryTrackGeneration(track.slug)
              .then(() => {
                setRetrying(false);
                void queryClient.invalidateQueries({ queryKey: ['tracks'] });
                void queryClient.invalidateQueries({ queryKey: ['tracks', track.slug] });
              })
              .catch(() => {
                setRetrying(false);
                setRetryError(true);
              });
          }}
        >
          {retrying ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          Retry
        </Button>
        {retryError ? <p className="text-caption text-danger">Retry didn&apos;t start.</p> : null}
      </Card>
    );
  }

  const complete = track.day === null && track.status === 'completed';
  const penciledDay = weekday(track.nextPlannedDate);
  const target = targetDate
    ? new Intl.DateTimeFormat('en-US', {
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(new Date(`${targetDate}T12:00:00Z`))
    : null;
  return (
    <Link href={`/app/tracks/${track.slug}`} className="group block">
      <Card className="min-h-48 transition-colors duration-150 group-hover:border-primary/50">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-h3 font-medium tracking-tight">{track.title}</h2>
          <p className="text-body-sm text-muted-foreground">
            {GOAL_LABEL[track.goalType]}
            {target ? ` · ${target}` : ''}
          </p>
        </div>
        <TrackSparkline track={track} />
        <p className="mt-auto font-mono text-caption text-muted-foreground">
          {complete
            ? 'complete'
            : track.day
              ? `day ${track.day.head} of ${track.day.total}${penciledDay ? ` · penciled ${penciledDay}` : ''}`
              : 'roadmap ready'}
        </p>
      </Card>
    </Link>
  );
}

function GlobalStrip({ data }: { data: DashboardData | undefined }) {
  if (!data) return null;
  const due = data.reviewQueue.dueToday + data.reviewQueue.overdue;
  return (
    <section
      aria-label="Global learning summary"
      className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border bg-surface px-4 py-3 font-mono text-caption text-muted-foreground"
    >
      <span className="flex items-center gap-1.5">
        <Flame className="size-3.5 text-warn" aria-hidden />
        <span className="numeric">{data.user.streakDays}</span> day streak
      </span>
      <Link href="/app/review" className="flex items-center gap-1.5 hover:text-foreground">
        <RotateCcw className="size-3.5 text-primary" aria-hidden />
        <span className="numeric">{due}</span> review due
      </Link>
      <Link
        href="/app/memory"
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 hover:text-foreground"
      >
        <GitCommitHorizontal className="size-3.5 shrink-0" aria-hidden />
        {data.timeline.slice(0, 3).map((commit) => (
          <span key={commit.sha} className="max-w-64 truncate">
            <span className="text-primary-legible">{commitBadge(commit)}</span> {commit.headline}
          </span>
        ))}
      </Link>
      <Link href="/app/dashboard" className="text-primary-legible hover:text-primary">
        View full dashboard →
      </Link>
    </section>
  );
}

export function TrackGallery() {
  const tracks = useTracks();
  const dashboard = useDashboard();
  const queryClient = useQueryClient();

  // Status flips without a commit (generating→failed, retry→generating) never
  // reach publishCommit's invalidation — refresh the gallery on track.updated
  // so a retried card resumes updating (QA F6).
  useUserSocketEvents((event) => {
    if (event.type === 'track.updated') {
      void queryClient.invalidateQueries({ queryKey: ['tracks'] });
      void queryClient.invalidateQueries({ queryKey: ['tracks', event.slug] });
    }
  });

  if (tracks.isPending) {
    return (
      <div className="grid animate-pulse gap-4 p-8 sm:grid-cols-2" aria-hidden>
        <div className="h-48 rounded-lg border bg-surface" />
        <div className="h-48 rounded-lg border bg-surface" />
      </div>
    );
  }
  if (tracks.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="Your tracks can’t load yet"
          description="Your memory is intact — retry asks the same track list endpoint."
          detail={tracks.error instanceof Error ? tracks.error.message : undefined}
          onRetry={() => void tracks.refetch()}
        />
      </div>
    );
  }

  if (tracks.data.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={Route}
          title="No tracks yet."
          description="Tell the agent what you're aiming at. It drafts the plan; you watch it commit."
          cta={{ label: 'Start your first track', href: '/app/tracks/new' }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-h2 font-medium tracking-tight">
            Welcome back{dashboard.data ? `, ${dashboard.data.user.displayName}` : ''}
          </h1>
          <p className="text-body-sm text-muted-foreground">Your roadmaps, paced by progress.</p>
        </div>
        <Button asChild>
          <Link href="/app/tracks/new">
            <Plus className="size-4" aria-hidden />
            New track
          </Link>
        </Button>
      </header>
      <div className={cn('grid gap-4 sm:grid-cols-2')}>
        {tracks.data.map((track) => (
          <TrackCard
            key={track.id}
            track={track}
            targetDate={
              dashboard.data?.readiness.find((item) => item.track === track.slug)?.targetDate
            }
          />
        ))}
      </div>
      <GlobalStrip data={dashboard.data} />
    </div>
  );
}
