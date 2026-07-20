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
      {/* Fixed-viewport app shell: data-app-shell drives the globals.css
          body:has() scroll lock — stray body-level helper DOM (portals,
          Monaco measurement nodes) otherwise makes the DOCUMENT taller than
          the viewport and focus/navigation scrolls the whole app away.
          Every pane owns its own scrolling. */}
      <div data-app-shell className="flex h-dvh overflow-hidden">
        <AppSidebar />
        <main className="flex h-dvh flex-1 flex-col overflow-y-auto">{children}</main>
      </div>
    </CommandPaletteProvider>
  );
}
