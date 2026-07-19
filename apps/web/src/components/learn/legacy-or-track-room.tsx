'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { listThreads } from '@/lib/api';
import { TutorRoom } from './tutor-room';

/**
 * Thread metadata only exists on the list endpoint. Resolve it before mounting
 * a room so track sessions keep their persistent rail and canonical URL.
 */
export function LegacyOrTrackRoom({ threadId }: { threadId: string }) {
  const router = useRouter();
  const threads = useQuery({
    queryKey: ['threads'],
    queryFn: ({ signal }) => listThreads(undefined, signal),
    retry: false,
  });
  const thread = threads.data?.threads.find((candidate) => candidate.id === threadId);
  const trackHref =
    thread?.trackSlug && thread.roadmapDay ? `/app/tracks/${thread.trackSlug}/s/${threadId}` : null;

  useEffect(() => {
    if (trackHref) router.replace(trackHref);
  }, [router, trackHref]);

  if (threads.isPending || trackHref) return null;
  return <TutorRoom threadId={threadId} />;
}
