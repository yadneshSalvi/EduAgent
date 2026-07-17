'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SubmitQuizRequest } from '@eduagent/shared';
import { useTurnStream } from '@/hooks/use-turn-stream';
import { interruptThread, listThreads, submitExercise, submitQuiz } from '@/lib/api';
import { TutorRoomView } from '@/components/chat/tutor-room-view';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';

/**
 * Live tutor room container (plans/04 §3): useTurnStream on the thread
 * socket; memory commits forward into the app-wide toast/drawer surface;
 * Esc / Stop hit POST /api/threads/:id/interrupt. Workbench submissions POST
 * to the exercise/quiz endpoints — verdicts come back over the same socket.
 */
export function TutorRoom({ threadId }: { threadId: string }) {
  const { publishCommit } = useMemoryCommits();
  const stream = useTurnStream(threadId, { onCommit: publishCommit });

  // Thread meta (title, topic chip) from the list endpoint; the room works
  // fine without it (mono thread id as the title fallback).
  const threadsQuery = useQuery({
    queryKey: ['threads'],
    queryFn: ({ signal }) => listThreads(undefined, signal),
    retry: false,
  });
  const thread = threadsQuery.data?.threads.find((t) => t.id === threadId);

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

  return (
    <TutorRoomView
      title={thread?.title || `thread/${threadId.slice(0, 8)}`}
      topicSlug={thread?.topicSlug ?? null}
      threadId={threadId}
      stream={stream}
      onInterrupt={onInterrupt}
      onSubmitExercise={onSubmitExercise}
      onSubmitQuiz={onSubmitQuiz}
    />
  );
}
