import { Compass } from 'lucide-react';
import { EmptyState } from '@/components/shared/empty-state';

export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-8">
      <EmptyState
        icon={Compass}
        title="This page isn't in memory."
        description="Nothing lives at this address. Your memory is intact — head back to the dashboard."
        example="404 · path not found"
        cta={{ label: 'Back to dashboard', href: '/app' }}
      />
    </main>
  );
}
