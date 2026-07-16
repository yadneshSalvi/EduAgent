import type { Metadata } from 'next';
import { RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Review' };

export default function ReviewPage() {
  return (
    <>
      <PageHeader
        title="Review"
        description="A daily queue that keeps mastery from decaying — questions generated fresh from your memory."
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={RotateCcw}
          title="Nothing due yet."
          description="Once you've learned something, it shows up here on a spaced-repetition schedule — each time attacked from a new angle, never the same flashcard twice."
          example="inner-join · due in 3 days · a new angle each time"
          cta={{ label: 'Learn something to review', href: '/app/learn' }}
        />
      </div>
    </>
  );
}
