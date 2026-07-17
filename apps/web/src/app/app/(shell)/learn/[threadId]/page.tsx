import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { slugSchema } from '@eduagent/shared';
import { TutorRoom } from '@/components/learn/tutor-room';

export const metadata: Metadata = { title: 'Tutor room' };

export default async function TutorRoomPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  // Thread ids are kebab-case slugs (00_goals §9); anything else is a 404.
  if (!slugSchema.safeParse(threadId).success) {
    notFound();
  }

  return <TutorRoom threadId={threadId} />;
}
