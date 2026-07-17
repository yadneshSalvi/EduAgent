import type { ReactNode } from 'react';
import { AppProviders } from './providers';

/**
 * /app/* root (plans/04 §1): providers only. The sidebar shell lives in the
 * (shell) route group; /app/onboarding renders full-screen wizard chrome
 * OUTSIDE the shell (04 §8) while still getting the query client and the
 * memory-commit toast/drawer surface.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
