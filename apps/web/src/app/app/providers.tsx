'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryCommitProvider } from '@/components/memory/memory-commit-provider';

/**
 * Client providers for everything under /app (plans/04 §1): TanStack Query
 * (REST server state) + the memory-commit surface (user socket, toast
 * viewport, Diff Drawer). Lives above BOTH the sidebar shell and the
 * full-screen onboarding chrome so commits toast anywhere.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryCommitProvider>{children}</MemoryCommitProvider>
    </QueryClientProvider>
  );
}
