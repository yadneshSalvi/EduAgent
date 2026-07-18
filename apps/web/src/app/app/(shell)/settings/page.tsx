import type { Metadata } from 'next';
import Link from 'next/link';
import { Settings2 } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';

export const metadata: Metadata = { title: 'Settings' };

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" description="Display name and timezone." />
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
        <EmptyState
          icon={Settings2}
          title="Not much to set."
          description="Display name and timezone land here. Learning preferences don't — change those by telling the tutor, and it remembers."
          example='"go easier on the SQL drills" → committed to profile.md'
          cta={{ label: 'Back to dashboard', href: '/app' }}
        />
        {process.env.AUTH_MODE === 'local' ? (
          <Link
            href="/login"
            className="flex h-10 items-center rounded-md px-3 text-body-sm text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
          >
            Switch profile
          </Link>
        ) : null}
      </div>
    </>
  );
}
