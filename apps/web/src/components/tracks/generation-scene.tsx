'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTurnStream } from '@/hooks/use-turn-stream';
import { useTrackDetail } from '@/hooks/use-tracks';
import { retryTrackGeneration } from '@/lib/api';
import { useUserSocketEvents } from '@/components/memory/memory-commit-provider';
import { ReasoningPreview } from '@/components/chat/reasoning-preview';
import { ErrorState } from '@/components/shared/error-state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Planning stays honest: every line below came from the plan thread or the
 * track state machine. The detail poll covers user-socket frames lost during reload.
 */
export function GenerationScene({
  slug,
  planThreadId,
  fullScreen = false,
}: {
  slug: string;
  planThreadId: string;
  fullScreen?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const reducedMotion = useReducedMotion();
  const detail = useTrackDetail(slug);
  const [threadId, setThreadId] = useState(planThreadId);
  const [retrying, setRetrying] = useState(false);
  const stream = useTurnStream(threadId);

  useUserSocketEvents((event) => {
    if (event.type === 'track.updated' && event.slug === slug) {
      void queryClient.invalidateQueries({ queryKey: ['tracks', slug] });
      void queryClient.invalidateQueries({ queryKey: ['tracks'] });
      if (event.status === 'active') {
        void detail.refetch().then(() => router.push(`/app/tracks/${slug}?born=1`));
      }
    }
  });

  useEffect(() => {
    if (detail.data?.status === 'active') router.push(`/app/tracks/${slug}?born=1`);
  }, [detail.data?.status, router, slug]);

  useEffect(() => {
    if (stream.state.turnStatus === 'idle' && detail.data?.status === 'generating') {
      void detail.refetch();
    }
  }, [stream.state.turnStatus, detail.data?.status, detail.refetch]);

  if (detail.data?.status === 'failed') {
    return (
      <div
        className={cn(
          'flex flex-1 items-center justify-center p-8',
          fullScreen ? 'min-h-dvh' : 'min-h-full',
        )}
      >
        <ErrorState
          title="The roadmap draft needs another pass"
          description="Your memory is intact. Retry continues with the same track."
          retryLabel="Retry"
          onRetry={() => {
            setRetrying(true);
            retryTrackGeneration(slug)
              .then((result) => {
                setThreadId(result.planThreadId);
                setRetrying(false);
                void detail.refetch();
              })
              .catch(() => setRetrying(false));
          }}
          secondary={
            <Button asChild variant="ghost">
              <Link href="/app">Back to tracks</Link>
            </Button>
          }
        />
        {retrying ? <span className="sr-only">Retrying roadmap generation</span> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'relative flex flex-1 items-center justify-center overflow-hidden p-8',
        fullScreen ? 'min-h-dvh' : 'min-h-full',
      )}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 55% 45% at 50% 42%, color-mix(in srgb, var(--accent) 12%, transparent), transparent)',
        }}
      />
      <motion.section
        aria-label="Drafting your roadmap"
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
        className="relative flex w-full max-w-2xl flex-col gap-6 rounded-lg border bg-surface/90 p-6"
      >
        <div className="flex items-center gap-3">
          <span className="chip-dots text-primary" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <div>
            <h1 className="font-display text-h2 font-medium">Drafting your roadmap…</h1>
            <p className="font-mono text-caption text-muted-foreground">plan/{slug}</p>
          </div>
        </div>

        <div className="flex flex-col gap-2" aria-live="polite">
          {stream.state.activityChips.map((activity) => (
            <div
              key={activity.id}
              className={cn(
                'flex min-h-8 items-center gap-2 rounded-sm bg-surface-2 px-3 font-mono text-caption',
                activity.status === 'failed' ? 'text-danger' : 'text-muted-foreground',
              )}
            >
              <span>{activity.label}</span>
              {activity.status === 'started' ? (
                <span className="chip-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                <span aria-hidden>{activity.status === 'completed' ? '✓' : '×'}</span>
              )}
            </div>
          ))}
          <ReasoningPreview text={stream.state.reasoningPreview} />
        </div>

        <p className="font-serif italic text-body-sm text-muted-foreground">
          The roadmap appears when its real memory commit is ready.
        </p>
      </motion.section>
    </div>
  );
}
