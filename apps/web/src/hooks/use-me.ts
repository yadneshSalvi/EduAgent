'use client';

import { useQuery } from '@tanstack/react-query';
import type { MeResponse } from '@eduagent/shared';
import { getMe } from '@/lib/api';

/**
 * Current session → app profile (plans/04 §2). 401 / unreachable host simply
 * yield no data — surfaces render their signed-out treatment, never crash.
 */
export function useMe() {
  return useQuery<MeResponse>({
    queryKey: ['auth', 'me'],
    queryFn: ({ signal }) => getMe(signal),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
}
