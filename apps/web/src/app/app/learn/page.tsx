import type { Metadata } from 'next';
import { GraduationCap } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Learn' };

export default function LearnPage() {
  return (
    <>
      <PageHeader
        title="Learn"
        description="Pick a topic — the tutor takes it from there, in small chunks with real exercises."
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={GraduationCap}
          title="What are you learning?"
          description="Name a topic and the tutor calibrates to what you already know. Code exercises are graded by actually running your code in the sandbox."
          example='try: "SQL joins" · "binary search" · "python generators"'
          cta={{ label: 'Start a session', href: '/app/learn/demo-thread' }}
          hint="The topic picker goes live with the agent host — this opens a placeholder tutor room."
        />
      </div>
    </>
  );
}
