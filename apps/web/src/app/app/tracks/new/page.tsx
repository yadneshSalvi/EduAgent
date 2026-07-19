import type { Metadata } from 'next';
import { TrackWizard } from '@/components/tracks/track-wizard';

export const metadata: Metadata = { title: 'New track' };

export default function NewTrackPage() {
  return <TrackWizard />;
}
