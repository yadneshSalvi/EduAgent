'use client';

import { notFound } from 'next/navigation';
import { useTrackDetail } from '@/hooks/use-tracks';
import { isTrackNotFound } from '@/lib/tracks';

/**
 * Layout-level existence check (QA F3). Keeping this outside the sidebar tree
 * means every track child route is protected even when the sidebar is hidden.
 */
export function TrackNotFoundGuard({ slug }: { slug: string }) {
  const detail = useTrackDetail(slug);
  if (isTrackNotFound(detail.error)) notFound();
  return null;
}
