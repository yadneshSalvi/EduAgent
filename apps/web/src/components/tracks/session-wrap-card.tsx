'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, RotateCcw, Wrench } from 'lucide-react';
import type { SessionWrapChatMessage } from '@/hooks/use-turn-stream';
import { useTrackDetail } from '@/hooks/use-tracks';
import { completeTrackDay, createTrackSession } from '@/lib/api';
import { DeltaTickChip } from '@/components/memory/commit-toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function SessionWrapCard({
  message,
  trackSlug,
  threadId,
}: {
  message: SessionWrapChatMessage;
  trackSlug: string;
  threadId: string;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const detail = useTrackDetail(trackSlug);
  const [pending, setPending] = useState<'complete' | 'revise' | 'mistakes' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const complete = detail.data?.completedDays.includes(message.wrap.day) ?? false;

  const start = (intent: 'revise' | 'mistakes') => {
    setPending(intent);
    setError(null);
    createTrackSession(trackSlug, { day: message.wrap.day, intent })
      .then((thread) => {
        void queryClient.invalidateQueries({ queryKey: ['tracks', trackSlug, 'sessions'] });
        router.push(`/app/tracks/${trackSlug}/s/${thread.id}`);
      })
      .catch((caught: unknown) => {
        setPending(null);
        setError(caught instanceof Error ? caught.message : 'The next session could not start.');
      });
  };

  const markComplete = () => {
    if (complete) return;
    setPending('complete');
    setError(null);
    completeTrackDay(trackSlug, message.wrap.day, { threadId })
      .then((updated) => {
        const previousDates = Object.fromEntries(
          detail.data?.roadmap?.days.map((day) => [day.day, day.plannedDate]) ?? [],
        );
        queryClient.setQueryData(['tracks', trackSlug, 'completion-beat'], {
          from: message.wrap.day,
          to: updated.headDay,
          previousDates,
        });
        queryClient.setQueryData(['tracks', trackSlug], updated);
        void queryClient.invalidateQueries({ queryKey: ['tracks'] });
        router.push(`/app/tracks/${trackSlug}`);
      })
      .catch((caught: unknown) => {
        setPending(null);
        setError(
          caught instanceof Error ? caught.message : 'The day could not be marked complete.',
        );
      });
  };

  return (
    <Card className="gap-4 border-primary/30 bg-surface p-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-display text-h3 font-medium">Good stopping point.</h2>
        <p className="line-clamp-2 whitespace-pre-wrap text-body-sm text-muted-foreground">
          {message.wrap.summary_md}
        </p>
      </div>
      {message.wrap.concept_deltas && message.wrap.concept_deltas.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {message.wrap.concept_deltas.map((delta, index) => (
            <DeltaTickChip
              key={`${delta.topic}:${delta.concept}`}
              concept={delta.concept}
              from={delta.from}
              to={delta.to}
              delayMs={index * 120}
            />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={complete || pending !== null}
          onClick={markComplete}
          className={cn(complete && 'bg-success text-background')}
        >
          {pending === 'complete' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Check className="size-4" aria-hidden />
          )}
          {complete ? `Day ${message.wrap.day} complete` : `Mark Day ${message.wrap.day} complete`}
        </Button>
        <Button variant="outline" disabled={pending !== null} onClick={() => start('revise')}>
          {pending === 'revise' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="size-4" aria-hidden />
          )}
          Revise this topic
        </Button>
        <Button variant="outline" disabled={pending !== null} onClick={() => start('mistakes')}>
          {pending === 'mistakes' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Wrench className="size-4" aria-hidden />
          )}
          Learn from my mistakes
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
