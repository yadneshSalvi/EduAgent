import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { slugSchema } from '@eduagent/shared';
import { ExamView } from '@/components/exam/exam-view';

export const metadata: Metadata = { title: 'Exam room' };

/**
 * The exam room renders OUTSIDE the (shell) route group on purpose
 * (plans/04 §6): a timed sitting is distraction-free, so the sidebar stays
 * collapsed and ExamView owns the full-screen chrome.
 */
export default async function ExamRoomPage({ params }: { params: Promise<{ examId: string }> }) {
  const { examId } = await params;
  // Exam ids are kebab-case slugs/uuids (00_goals §9); anything else is a 404.
  if (!slugSchema.safeParse(examId).success) {
    notFound();
  }

  return <ExamView examId={examId} />;
}
