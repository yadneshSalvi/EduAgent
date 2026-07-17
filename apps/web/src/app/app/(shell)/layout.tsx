import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/shared/app-sidebar';

/**
 * Sidebar shell (plans/04 §1): left nav + content area (max-w none; every
 * page owns its scroll). Onboarding and the dev harness live outside this
 * group and get full-screen chrome.
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <AppSidebar />
      <main className="flex h-dvh flex-1 flex-col overflow-y-auto">{children}</main>
    </div>
  );
}
