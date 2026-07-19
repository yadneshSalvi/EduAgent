import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { slugSchema } from '@eduagent/shared';
import { TrackRail } from '@/components/tracks/track-rail';

export default async function TrackLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!slugSchema.safeParse(slug).success) notFound();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
      <TrackRail slug={slug} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
