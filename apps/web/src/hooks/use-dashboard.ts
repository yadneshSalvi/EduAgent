'use client';

import { useQuery } from '@tanstack/react-query';
import type { DashboardData } from '@eduagent/shared';
import { getDashboard } from '@/lib/api';

/**
 * The whole dashboard payload (plans/02 §6) — one query, shared by the
 * dashboard page and the sidebar (due badge, streak). Invalidated on every
 * memory.commit by MemoryCommitProvider.
 */
export function useDashboard() {
  return useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: ({ signal }) => getDashboard(signal),
    staleTime: 30_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}
