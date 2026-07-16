import type { Metadata } from 'next';
import { Sparkles } from 'lucide-react';
import { PageHeader } from '@/components/shared/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { cn } from '@/lib/utils';

export const metadata: Metadata = { title: 'Onboarding' };

const STEPS = ['Goal', 'Background', 'Baseline', 'Ready'] as const;
const CURRENT_STEP = 0;

export default function OnboardingPage() {
  return (
    <>
      <PageHeader
        title="Welcome"
        description="A short interview, then your memory is born."
        actions={
          <ol className="flex items-center gap-2" aria-label="Onboarding steps">
            {STEPS.map((step, i) => (
              <li
                key={step}
                aria-current={i === CURRENT_STEP ? 'step' : undefined}
                className={cn(
                  'rounded-sm border px-2.5 py-1 text-caption font-medium',
                  i === CURRENT_STEP
                    ? 'border-transparent bg-accent-soft text-primary'
                    : 'text-muted-foreground',
                )}
              >
                {step}
              </li>
            ))}
          </ol>
        }
      />
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={Sparkles}
          title="Your memory is born here."
          description="The tutor interviews you — goal, background, a short baseline quiz — and ends with your very first memory commit. From then on, it never starts from zero again."
          example="init(memory): profile.md · goals.md · baseline assessed"
          cta={{ label: 'Begin the interview', disabled: true }}
          hint="The interview is conducted by the tutor — it goes live with the agent host."
        />
      </div>
    </>
  );
}
