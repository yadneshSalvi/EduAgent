'use client';

import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTurnStream } from '@/hooks/use-turn-stream';
import { interruptThread, listThreads } from '@/lib/api';
import { TutorRoomView } from '@/components/chat/tutor-room-view';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';

/**
 * Live tutor room container (plans/04 §3): useTurnStream on the thread
 * socket; memory commits forward into the app-wide toast/drawer surface;
 * Esc / Stop hit POST /api/threads/:id/interrupt.
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

  return (
    <TutorRoomView
      title={thread?.title || `thread/${threadId.slice(0, 8)}`}
      topicSlug={thread?.topicSlug ?? null}
      stream={stream}
      onInterrupt={onInterrupt}
    />
  );
}
