import type { Metadata } from 'next';
import { PageHeader } from '@/components/shared/page-header';
import { LearnPicker } from '@/components/learn/learn-picker';

export const metadata: Metadata = { title: 'Learn' };

export default function LearnPage() {
  return (
    <>
      <PageHeader
        title="Learn"
        description="Pick a topic — the tutor calibrates to what you already know and grades exercises by actually running your code."
      />
      <LearnPicker />
    </>
  );
}
