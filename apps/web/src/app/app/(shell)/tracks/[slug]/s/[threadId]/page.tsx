import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { slugSchema } from '@eduagent/shared';
import { TutorRoom } from '@/components/learn/tutor-room';

export const metadata: Metadata = { title: 'Track session' };

export default async function TrackSessionPage({
  params,
}: {
  params: Promise<{ slug: string; threadId: string }>;
}) {
  const { slug, threadId } = await params;
  if (!slugSchema.safeParse(slug).success || !slugSchema.safeParse(threadId).success) notFound();
  return <TutorRoom threadId={threadId} trackSlug={slug} showWrapUp />;
}
