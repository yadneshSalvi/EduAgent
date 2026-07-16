import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/shared/app-sidebar';

/**
 * /app/* shell (plans/04 §1): left sidebar nav + content area (max-w none;
 * every page owns its scroll). Command palette, toast viewport, and the WS
 * providers land in Phase 1.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <AppSidebar />
      <main className="flex h-dvh flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  );
}
