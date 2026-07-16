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
          description="Browse profile, mastery, and misconception files; scrub the Time Machine between any two days and watch your knowledge diff. It starts with your first lesson."
          example="git log --oneline memory/ · 0 commits (for now)"
          cta={{ label: 'Plant the first commit', href: '/app/learn' }}
          secondaryCta={{ label: 'Export my memory', disabled: true }}
        />
      </div>
    </>
  );
}
