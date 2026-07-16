import type { Metadata } from 'next';
import { LayoutDashboard } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Dashboard' };

export default function DashboardPage() {
  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Mastery, forgetting curves, streak, and your memory timeline — at a glance."
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={LayoutDashboard}
          title="Your memory starts empty."
          description="Every session fills this in: a mastery heatmap, forgetting curves, readiness per track, and a live feed of commits to your memory."
          example="learn(sql): inner joins clicked — mastery 0.40 → 0.72"
          cta={{ label: 'Start learning', href: '/app/learn' }}
        />
      </div>
    </>
  );
}
