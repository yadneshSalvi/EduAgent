import type { Metadata } from 'next';
import { PageHeader } from '@/components/shared/page-header';
import { ExamSetup } from '@/components/exam/exam-setup';

export const metadata: Metadata = { title: 'Exam' };

export default function ExamPage() {
  return (
    <>
      <PageHeader
        title="Exam"
        description="Timed mock exams, forked from your memory and aimed at your weakest concepts."
      />
      <ExamSetup />
    </>
  );
}
