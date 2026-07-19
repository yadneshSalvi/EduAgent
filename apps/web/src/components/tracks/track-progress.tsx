'use client';

import { useTrackDetail } from '@/hooks/use-tracks';
import { DashboardView } from '@/components/dashboard/dashboard-view';
import { RoadmapHeader } from './roadmap';

/** Keeps the track identity and tabs fixed while reusing the scoped dashboard. */
export function TrackProgress({ slug }: { slug: string }) {
  const detail = useTrackDetail(slug);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {detail.data?.roadmap ? <RoadmapHeader detail={detail.data} active="progress" /> : null}
      <DashboardView trackSlug={slug} />
    </div>
  );
}
