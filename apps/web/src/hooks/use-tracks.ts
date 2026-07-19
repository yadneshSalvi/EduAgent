'use client';

import { useQuery } from '@tanstack/react-query';
import { getTrackDetail, getTrackSessions, listTracks } from '@/lib/api';

/**
 * Track queries share the `['tracks']` root so one memory.commit refreshes
 * gallery summaries, roadmap derivations, and the persistent session tree.
 */
export function useTracks() {
  return useQuery({
    queryKey: ['tracks'],
    queryFn: ({ signal }) => listTracks(signal),
    select: (response) => response.tracks,
  });
}

export function useTrackDetail(slug: string, enabled = true) {
  return useQuery({
    queryKey: ['tracks', slug],
    queryFn: ({ signal }) => getTrackDetail(slug, signal),
    enabled,
    refetchInterval: (query) => (query.state.data?.status === 'generating' ? 3_000 : false),
  });
}

export function useTrackSessions(slug: string, enabled = true) {
  return useQuery({
    queryKey: ['tracks', slug, 'sessions'],
    queryFn: ({ signal }) => getTrackSessions(slug, signal),
    enabled,
  });
}
