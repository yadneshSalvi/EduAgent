import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { slugSchema } from '@eduagent/shared';
import { Roadmap } from '@/components/tracks/roadmap';

export const metadata: Metadata = { title: 'Roadmap' };

export default async function TrackPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ born?: string }>;
}) {
  const [{ slug }, { born }] = await Promise.all([params, searchParams]);
  if (!slugSchema.safeParse(slug).success) notFound();
  return <Roadmap slug={slug} born={born === '1'} />;
}
