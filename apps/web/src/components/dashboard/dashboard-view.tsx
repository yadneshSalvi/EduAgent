'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight, Flame, LayoutDashboard, Loader2, RotateCcw } from 'lucide-react';
import type { DashboardData } from '@eduagent/shared';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { useDashboard } from '@/hooks/use-dashboard';
import { createThread } from '@/lib/api';
import { ActivityStrip } from './activity-strip';
import { MasteryHeatmap } from './mastery-heatmap';
import { ReadinessGauge } from './readiness-gauge';
import { TimelineFeed } from './timeline-feed';

/**
 * The dashboard (plans/04 §4): header (greeting, streak, review pill,
 * continue CTA) → readiness gauges → mastery heatmap → forgetting curves →
 * memory timeline → activity strip. All data from one GET /api/dashboard
 * payload, invalidated on every memory.commit.
 */
const DecayChart = dynamic(() => import('./decay-chart').then((m) => m.DecayChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

function ChartSkeleton() {
  return (
    <div className="flex h-full min-h-[340px] animate-pulse flex-col gap-4 rounded-lg border bg-surface p-6">
      <div className="h-5 w-40 rounded-sm bg-surface-2" />
      <div className="flex-1 rounded-md bg-surface-2/60" />
    </div>
  );
}

/** Loading skeleton matching the final grid geometry (plans/05 §10). */
function DashboardSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-6 p-8" aria-hidden>
      <div className="flex items-end justify-between gap-6">
        <div className="flex flex-col gap-3">
          <div className="h-9 w-72 rounded-md bg-surface-2" />
          <div className="h-4 w-52 rounded-sm bg-surface-2" />
        </div>
        <div className="h-12 w-64 rounded-lg bg-surface-2" />
      </div>
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="h-[420px] rounded-lg border bg-surface lg:col-span-4" />
        <div className="h-[420px] rounded-lg border bg-surface lg:col-span-8" />
        <div className="h-[340px] rounded-lg border bg-surface lg:col-span-7" />
        <div className="h-[560px] rounded-lg border bg-surface lg:col-span-5 lg:row-span-2" />
        <div className="h-[180px] rounded-lg border bg-surface lg:col-span-7" />
      </div>
    </div>
  );
}

function ContinueCard({ cta }: { cta: NonNullable<DashboardData['continueCta']> }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const thread = await createThread({ mode: 'learn', topicSlug: cta.topicSlug });
      router.push(`/app/learn/${thread.id}`);
    } catch {
      setBusy(false);
      router.push('/app/learn');
    }
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => void start()}
      className="group flex items-center gap-3 rounded-lg border bg-surface px-4 py-3 text-left transition-colors duration-150 hover:border-primary/50 disabled:opacity-70"
    >
      <span className="flex flex-col gap-0.5">
        <span className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
          continue
        </span>
        <span className="text-body-sm font-medium">{cta.label}</span>
      </span>
      {busy ? (
        <Loader2 className="ml-1 size-4 shrink-0 animate-spin text-primary" aria-hidden />
      ) : (
        <ArrowRight
          className="ml-1 size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
          aria-hidden
        />
      )}
    </button>
  );
}

function DashboardHeader({ data }: { data: DashboardData }) {
  const due = data.reviewQueue.dueToday + data.reviewQueue.overdue;
  return (
    <header className="flex flex-wrap items-end justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-h2 font-medium tracking-tight">
          Welcome back, {data.user.displayName}
        </h1>
        <p className="flex items-center gap-2 text-body-sm text-muted-foreground">
          {data.user.streakDays > 0 ? (
            <>
              <span className="flex items-center gap-1 text-warn">
                <Flame className="size-4" aria-hidden />
                <span className="numeric font-semibold">{data.user.streakDays}</span>
              </span>
              day{data.user.streakDays === 1 ? '' : 's'} streak — the tutor remembers where you
              left off.
            </>
          ) : (
            'Your memory is live — every session commits to it.'
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {due > 0 ? (
          <Link
            href="/app/review"
            className="flex items-center gap-2 rounded-full border bg-surface px-4 py-2 text-body-sm font-medium transition-colors duration-150 hover:border-primary/50"
          >
            <RotateCcw className="size-4 text-primary" aria-hidden />
            <span className="numeric">{due}</span> due for review
          </Link>
        ) : null}
        {data.continueCta ? <ContinueCard cta={data.continueCta} /> : null}
      </div>
    </header>
  );
}

export function DashboardView() {
  const { data, isPending, isError, error, refetch } = useDashboard();

  const conceptTopic = useMemo(() => {
    const map = new Map<string, string>();
    for (const topic of data?.topics ?? []) {
      for (const concept of topic.concepts) map.set(concept.id, topic.topic);
    }
    return map;
  }, [data]);

  if (isPending) return <DashboardSkeleton />;

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="The dashboard can't load yet"
          description="Your memory is intact — the agent host just didn't answer. Retry hits the same endpoint."
          detail={error instanceof Error ? error.message : undefined}
          onRetry={() => void refetch()}
        />
      </div>
    );
  }

  const empty = data.topics.length === 0 && data.timeline.length === 0;
  if (empty) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={LayoutDashboard}
          title={`Welcome, ${data.user.displayName}.`}
          description="Every session feeds this view: a mastery heatmap, forgetting curves, readiness per track, and a live feed of commits to your memory."
          example="learn(sql): inner joins clicked — mastery 0.40 → 0.72"
          cta={{ label: 'Start learning', href: '/app/learn' }}
        />
      </div>
    );
  }

  const today = data.activity.at(-1)?.date ?? new Date().toISOString().slice(0, 10);

  return (
    <div className="flex flex-col gap-6 p-8">
      <DashboardHeader data={data} />

      <div className="grid items-start gap-6 lg:grid-cols-12">
        <div className="flex flex-col gap-6 lg:col-span-4">
          {data.readiness.map((readiness) => (
            <ReadinessGauge
              key={readiness.track}
              readiness={readiness}
              today={today}
              conceptTopic={conceptTopic}
            />
          ))}
        </div>
        <div className="lg:col-span-8">
          <MasteryHeatmap topics={data.topics} />
        </div>

        <div className="flex flex-col gap-6 lg:col-span-7">
          <DecayChart decaySeries={data.decaySeries} today={today} />
          <ActivityStrip activity={data.activity} />
        </div>
        <div className="max-h-[720px] lg:col-span-5">
          <TimelineFeed timeline={data.timeline} />
        </div>
      </div>
    </div>
  );
}
