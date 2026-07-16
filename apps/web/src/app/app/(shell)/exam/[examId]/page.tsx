import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Timer } from 'lucide-react';
import { slugSchema } from '@eduagent/shared';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Exam room' };

export default async function ExamRoomPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  // Exam ids are kebab-case slugs (00_goals §9); anything else is a 404.
  if (!slugSchema.safeParse(examId).success) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title="Exam room"
        description="Distraction-free and timed to the server's clock. Answers autosave as you go."
        meta={`exam/${examId}`}
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={Timer}
          title="The timed exam room lands here."
          description="Sticky timer, a question palette for flagging, full Monaco for coding questions — then a results view with per-concept breakdown and your readiness delta."
          example="42:17 remaining · 3 of 8 answered · 1 flagged"
          cta={{ label: 'Back to exam setup', href: '/app/exam' }}
        />
      </div>
    </>
  );
}
