import type { ReactNode } from 'react';
import { AppProviders } from './providers';

/**
 * /app/* root (plans/04 §1): providers only. The sidebar shell lives in the
 * (shell) route group; /app/onboarding and /app/tracks/new render full-screen
 * wizard chrome outside the shell while retaining queries and commit UI.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <AppProviders>{children}</AppProviders>;
}
