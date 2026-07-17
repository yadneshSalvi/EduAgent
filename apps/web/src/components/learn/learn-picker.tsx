'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Database, FileCode2, Loader2, type LucideIcon } from 'lucide-react';
import { ApiConnectionError, ApiError, createThread, listThreads } from '@/lib/api';
import { ErrorState } from '@/components/shared/error-state';
import { cn } from '@/lib/utils';

/**
 * Topic/track picker (plans/04 §1): SQL + Python for now, plus a "Continue"
 * slot from the latest learn thread. Picking a topic ensures a thread via
 * POST /api/threads {mode:'learn', topicSlug} and routes into the tutor room.
 */
interface TopicCard {
  slug: string;
  title: string;
  blurb: string;
  icon: LucideIcon;
}

const TOPICS: TopicCard[] = [
  {
    slug: 'sql',
    title: 'SQL',
    blurb: 'Joins, aggregation, window functions — graded against real query runs.',
    icon: Database,
  },
  {
    slug: 'python',
    title: 'Python',
    blurb: 'Idioms, generators, data structures — graded by running your code.',
    icon: FileCode2,
  },
];

function describeError(err: unknown): { description: string; detail?: string } {
  if (err instanceof ApiConnectionError) {
    return { description: err.message };
  }
  if (err instanceof ApiError && err.status === 404) {
    return {
      description:
        'The agent host is running but the thread routes are not wired up yet (they land with the tutor backend). The room is ready — retry once the server side is up.',
      detail: `POST /api/threads → 404 ${err.code}`,
    };
  }
  if (err instanceof ApiError) {
    return { description: err.message, detail: `${err.status} ${err.code}` };
  }
  return { description: 'Something went wrong starting the session.' };
}

export function LearnPicker() {
  const router = useRouter();
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Continue slot: newest active learn thread. Errors stay silent — the
  // picker is fully usable without history.
  const threadsQuery = useQuery({
    queryKey: ['threads', 'learn'],
    queryFn: ({ signal }) => listThreads('learn', signal),
    retry: false,
  });
  const continueThread = threadsQuery.data?.threads
    .filter((thread) => thread.status === 'active')
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))[0];

  const start = async (topicSlug: string) => {
    setBusySlug(topicSlug);
    setError(null);
    try {
      const thread = await createThread({ mode: 'learn', topicSlug });
      router.push(`/app/learn/${thread.id}`);
    } catch (err) {
      setBusySlug(null);
      setError(err);
    }
  };

  if (error !== null) {
    const { description, detail } = describeError(error);
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="The tutor can't start a session yet"
          description={description}
          detail={detail}
          onRetry={() => setError(null)}
          retryLabel="Back to topics"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8 p-8">
      {continueThread ? (
        <section className="flex flex-col gap-3" aria-label="Continue learning">
          <h2 className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
            continue
          </h2>
          <button
            type="button"
            onClick={() => router.push(`/app/learn/${continueThread.id}`)}
            className="group flex w-full max-w-2xl items-center gap-4 rounded-lg border bg-surface px-5 py-4 text-left transition-colors duration-150 hover:border-primary/50"
          >
            <span className="flex flex-col gap-0.5">
              <span className="text-body font-medium">
                {continueThread.title || 'Pick up where you left off'}
              </span>
              <span className="font-mono text-caption text-muted-foreground">
                {continueThread.topicSlug ?? 'general'} · last active{' '}
                {new Date(continueThread.lastActiveAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}
              </span>
            </span>
            <ArrowRight
              className="ml-auto size-4 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
              aria-hidden
            />
          </button>
        </section>
      ) : null}

      <section className="flex flex-col gap-3" aria-label="Topics">
        <h2 className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
          topics
        </h2>
        <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
          {TOPICS.map((topic) => {
            const Icon = topic.icon;
            const busy = busySlug === topic.slug;
            return (
              <button
                key={topic.slug}
                type="button"
                disabled={busySlug !== null}
                onClick={() => void start(topic.slug)}
                className={cn(
                  'group flex flex-col gap-3 rounded-lg border bg-surface p-5 text-left transition-colors duration-150',
                  'hover:border-primary/50 disabled:opacity-60',
                )}
              >
                <span className="flex size-10 items-center justify-center rounded-md bg-accent-soft text-primary">
                  {busy ? (
                    <Loader2 className="size-5 animate-spin" aria-hidden />
                  ) : (
                    <Icon className="size-5" aria-hidden />
                  )}
                </span>
                <span className="flex flex-col gap-1">
                  <span className="font-display text-h4 font-medium">{topic.title}</span>
                  <span className="text-body-sm text-muted-foreground">{topic.blurb}</span>
                </span>
                <span className="mt-1 flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
                  {topic.slug}
                  <ArrowRight
                    className="size-3.5 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary"
                    aria-hidden
                  />
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-caption text-muted-foreground/80">
          Any topic works once you&apos;re in the room — just tell the tutor what you want to
          learn.
        </p>
      </section>
    </div>
  );
}
