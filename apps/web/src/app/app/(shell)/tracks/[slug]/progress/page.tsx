import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { slugSchema } from '@eduagent/shared';
import { TrackProgress } from '@/components/tracks/track-progress';

export const metadata: Metadata = { title: 'Track progress' };

export default async function TrackProgressPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!slugSchema.safeParse(slug).success) notFound();
  return <TrackProgress slug={slug} />;
}
