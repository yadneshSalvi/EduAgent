import type { Metadata } from 'next';
import { DashboardView } from '@/components/dashboard/dashboard-view';

export const metadata: Metadata = { title: 'Dashboard' };

/**
 * The dashboard home (plans/04 §4) — everything renders client-side from
 * GET /api/dashboard, invalidated live on memory commits.
 */
export default function DashboardPage() {
  return <DashboardView />;
}
