import type { Metadata } from 'next';
import { OnboardingWizard } from '@/components/onboarding/onboarding-wizard';

export const metadata: Metadata = { title: 'Onboarding' };

/**
 * First-run wizard (plans/04 §8): full-screen chrome OUTSIDE the sidebar
 * shell — this route lives beside the (shell) group on purpose. `?preview=1`
 * (non-production only) drives the flow from scripted fixtures so the chrome
 * and the "memory born" moment can be exercised before task #11 lands.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ preview?: string }>;
}) {
  const { preview } = await searchParams;
  const previewMode = process.env.NODE_ENV !== 'production' && preview === '1';
  return <OnboardingWizard previewMode={previewMode} />;
}
