import type { Metadata } from 'next';
import { TrackGallery } from '@/components/tracks/track-gallery';

export const metadata: Metadata = { title: 'Tracks' };

/**
 * The dashboard home (plans/04 §4) — everything renders client-side from
 * GET /api/dashboard, invalidated live on memory commits.
 */
export default function DashboardPage() {
  return <TrackGallery />;
}
