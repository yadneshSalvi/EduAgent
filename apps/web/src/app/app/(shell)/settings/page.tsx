import type { Metadata } from 'next';
import { Settings2 } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Display name and timezone." />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={Settings2}
          title="Not much to set."
          description="Display name and timezone land here. Learning preferences don't — change those by telling the tutor, and it remembers."
          example='"go easier on the SQL drills" → committed to profile.md'
          cta={{ label: 'Back to dashboard', href: '/app' }}
        />
      </div>
    </>
  );
}
