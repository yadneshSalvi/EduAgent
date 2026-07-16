import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EmptyStateCta {
  label: string;
  /** Link CTA. Omit and set `disabled` for not-yet-wired actions. */
  href?: string;
  disabled?: boolean;
  variant?: 'default' | 'outline';
}

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  /** One line that teaches what the feature does (05 §8). */
  description: string;
  /** Optional mono example line — memory speaks terminal. */
  example?: string;
  cta?: EmptyStateCta;
  secondaryCta?: EmptyStateCta;
  /** Muted footnote, e.g. why a CTA is disabled. */
  hint?: string;
  className?: string;
}

function CtaButton({ cta }: { cta: EmptyStateCta }) {
  if (cta.href && !cta.disabled) {
    return (
      <Button asChild variant={cta.variant ?? 'default'}>
        <Link href={cta.href}>{cta.label}</Link>
      </Button>
    );
  }
  return (
    <Button variant={cta.variant ?? 'default'} disabled={cta.disabled}>
      {cta.label}
    </Button>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  example,
  cta,
  secondaryCta,
  hint,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-surface px-8 py-12 text-center',
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-md bg-accent-soft text-primary">
        <Icon className="size-6" aria-hidden />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-h3 font-medium">{title}</h2>
        <p className="text-body text-muted-foreground">{description}</p>
      </div>
      {example ? (
        <code className="rounded-sm bg-surface-2 px-3 py-1.5 font-mono text-caption text-muted-foreground">
          {example}
        </code>
      ) : null}
      {cta || secondaryCta ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
          {cta ? <CtaButton cta={cta} /> : null}
          {secondaryCta ? <CtaButton cta={{ variant: 'outline', ...secondaryCta }} /> : null}
        </div>
      ) : null}
      {hint ? <p className="text-caption text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}
