'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubmitQuizRequest } from '@eduagent/shared';
import { useTurnStream } from '@/hooks/use-turn-stream';
import {
  createTrackSession,
  interruptThread,
  listThreads,
  submitExercise,
  submitQuiz,
} from '@/lib/api';
import { TutorRoomView } from '@/components/chat/tutor-room-view';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';
import { useTrackDetail } from '@/hooks/use-tracks';
import { Button } from '@/components/ui/button';

/**
 * Live tutor room container (plans/04 §3): useTurnStream on the thread
 * socket; memory commits forward into the app-wide toast/drawer surface;
 * Esc / Stop hit POST /api/threads/:id/interrupt. Workbench submissions POST
 * to the exercise/quiz endpoints — verdicts come back over the same socket.
 */
export function TutorRoom({
  threadId,
  topbarExtra,
  badgeText,
  trackSlug,
  showWrapUp = false,
}: {
  threadId: string;
  topbarExtra?: ReactNode;
  badgeText?: string;
  trackSlug?: string;
  showWrapUp?: boolean;
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { publishCommit } = useMemoryCommits();
  const stream = useTurnStream(threadId, { onCommit: publishCommit });
  const [revisionPending, setRevisionPending] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);

  // Thread meta (title, topic chip) from the list endpoint; the room works
  // fine without it (mono thread id as the title fallback).
  const threadsQuery = useQuery({
    queryKey: ['threads'],
    queryFn: ({ signal }) => listThreads(undefined, signal),
    retry: false,
  });
  const thread = threadsQuery.data?.threads.find((t) => t.id === threadId);
  const resolvedTrackSlug = trackSlug ?? thread?.trackSlug ?? '';
  const trackDetail = useTrackDetail(resolvedTrackSlug, resolvedTrackSlug !== '');
  const roadmapDay = thread?.roadmapDay ?? null;
  const archived = thread?.status === 'archived';
  const dayTitle = trackDetail.data?.roadmap?.days.find((day) => day.day === roadmapDay)?.title;
  const resolvedBadge =
    badgeText ??
    (roadmapDay ? `day/${roadmapDay} · ${dayTitle ?? thread?.title ?? 'session'}` : undefined);

  const onInterrupt = useCallback(() => {
    interruptThread(threadId).catch((err: unknown) => {
      console.warn('interrupt failed', err);
    });
  }, [threadId]);

  const onSubmitExercise = useCallback(
    (exerciseId: string, code: string) => submitExercise(exerciseId, { code }),
    [],
  );

  const onSubmitQuiz = useCallback(
    (quizId: string, answers: SubmitQuizRequest['answers']) => submitQuiz(quizId, { answers }),
    [],
  );

  const onRevise = useCallback(() => {
    if (!resolvedTrackSlug || roadmapDay === null) return;
    setRevisionPending(true);
    setRevisionError(null);
    createTrackSession(resolvedTrackSlug, { day: roadmapDay, intent: 'revise' })
      .then((created) => {
        void queryClient.invalidateQueries({
          queryKey: ['tracks', resolvedTrackSlug, 'sessions'],
        });
        router.push(`/app/tracks/${resolvedTrackSlug}/s/${created.id}`);
      })
      .catch((caught: unknown) => {
        setRevisionPending(false);
        setRevisionError(
          caught instanceof Error ? caught.message : 'The revision could not start.',
        );
      });
  }, [queryClient, resolvedTrackSlug, roadmapDay, router]);

  return (
    <TutorRoomView
      title={thread?.title || `thread/${threadId.slice(0, 8)}`}
      topicSlug={thread?.topicSlug ?? null}
      badgeText={resolvedBadge}
      threadId={threadId}
      stream={stream}
      onInterrupt={onInterrupt}
      onSubmitExercise={onSubmitExercise}
      onSubmitQuiz={onSubmitQuiz}
      archived={archived}
      onRevise={archived && roadmapDay !== null && resolvedTrackSlug ? onRevise : undefined}
      revisionPending={revisionPending}
      revisionError={revisionError}
      topbarExtra={
        <>
          {topbarExtra}
          {showWrapUp && !archived ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={stream.state.connection !== 'open'}
              onClick={() => stream.send("Let's wrap up this session.")}
            >
              Wrap up
            </Button>
          ) : null}
        </>
      }
      trackContext={resolvedTrackSlug ? { slug: resolvedTrackSlug, threadId } : undefined}
    />
  );
}
