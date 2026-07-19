import type { Metadata } from 'next';
import { DashboardView } from '@/components/dashboard/dashboard-view';

export const metadata: Metadata = { title: 'Dashboard' };

/** Global learning signals remain available from the gallery's summary strip. */
export default function DashboardPage() {
  return <DashboardView />;
}
