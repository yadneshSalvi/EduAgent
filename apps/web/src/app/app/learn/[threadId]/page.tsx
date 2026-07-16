import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { MessagesSquare } from 'lucide-react';
import { slugSchema } from '@eduagent/shared';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Tutor room' };

export default async function TutorRoomPage({ params }: { params: Promise<{ threadId: string }> }) {
  const { threadId } = await params;
  // Thread ids are kebab-case slugs (00_goals §9); anything else is a 404.
  if (!slugSchema.safeParse(threadId).success) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title="Tutor room"
        description="Chat with the tutor on the left; exercises, quizzes, and artifacts land in the workbench on the right."
        meta={`thread/${threadId}`}
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={MessagesSquare}
          title="The tutor opens every session."
          description="You'll never face a blank chat — the tutor greets you, recalls where you left off, and picks up from there. Streaming chat and the Monaco workbench arrive in Phase 1."
          example="⚙ running tests… · ✎ updating memory…"
          cta={{ label: 'Back to topics', href: '/app/learn' }}
        />
      </div>
    </>
  );
}
