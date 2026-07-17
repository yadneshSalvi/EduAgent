import type { Metadata } from 'next';
import { GitCommitHorizontal } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Memory' };

export default function MemoryPage() {
  return (
    <>
      <PageHeader
        title="Memory"
        description="The files the tutor keeps about you — versioned in git, readable, and yours to export."
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={GitCommitHorizontal}
          title="Your memory is a git repo."
          description="Browse profile, mastery, and misconception files; scrub the Time Machine between any two days and watch your knowledge diff. The explorer is on its way — your tutor is already writing to the repo it will show."
          example="git log --oneline memory/"
          cta={{ label: 'Open a lesson', href: '/app/learn' }}
          secondaryCta={{ label: 'Export my memory', disabled: true }}
        />
      </div>
    </>
  );
}
