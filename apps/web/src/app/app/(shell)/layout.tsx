import type { ReactNode } from 'react';
import { AppSidebar } from '@/components/shared/app-sidebar';
import { CommandPaletteProvider } from '@/components/shared/command-palette';

/**
 * Sidebar shell (plans/04 §1): left nav + content area (max-w none; every
 * page owns its scroll). Onboarding and the dev harness live outside this
 * group and get full-screen chrome — and deliberately no ⌘K palette (the
 * exam room stays a focused surface).
 */
export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <CommandPaletteProvider>
      {/* h-dvh + overflow-hidden: the shell is a fixed-viewport app — the
          document must never scroll (stray body-level helper DOM from portals
          or Monaco otherwise lets focus/navigation shift the whole page).
          Every pane owns its own scrolling. */}
      <div className="flex h-dvh overflow-hidden">
        <AppSidebar />
        <main className="flex h-dvh flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </CommandPaletteProvider>
  );
}
