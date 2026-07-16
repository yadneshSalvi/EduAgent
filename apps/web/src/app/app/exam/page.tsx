import type { Metadata } from 'next';
import { GitFork } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Exam' };

export default function ExamPage() {
  return (
    <>
      <PageHeader
        title="Exam"
        description="Timed mock exams, forked from your memory and aimed at your weakest concepts."
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={GitFork}
          title="Fork your memory into an exam."
          description="EduAgent forks your learning thread, reads your whole history, and writes a timed exam that targets exactly what you're weakest at. Results commit back — readiness updates."
          example="→ forked from your memory · targeting your weakest concepts"
          cta={{ label: 'Fork my memory into an exam', href: '/app/exam/demo-exam' }}
          hint="Exam generation goes live with the agent host — this opens a placeholder exam room."
        />
      </div>
    </>
  );
}
