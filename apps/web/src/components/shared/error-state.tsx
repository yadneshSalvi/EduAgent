'use client';

import type { LucideIcon } from 'lucide-react';
import { CircleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * Designed error state (plans/05 §8): what happened + what we did + one
 * action. Every error has a retry path — zero dead ends (00 §8).
 */
interface ErrorStateProps {
  icon?: LucideIcon;
  title: string;
  description: string;
  /** Mono detail line (underlying error, endpoint) — memory speaks terminal. */
  detail?: string;
  onRetry?: () => void;
  retryLabel?: string;
  secondary?: React.ReactNode;
  className?: string;
}

export function ErrorState({
  icon: Icon = CircleAlert,
  title,
  description,
  detail,
  onRetry,
  retryLabel = 'Retry',
  secondary,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-surface px-8 py-10 text-center',
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-md bg-danger/10 text-danger">
        <Icon className="size-6" aria-hidden />
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="font-display text-h4 font-medium">{title}</h2>
        <p className="text-body-sm text-muted-foreground">{description}</p>
      </div>
      {detail ? (
        <code className="max-w-full truncate rounded-sm bg-surface-2 px-3 py-1.5 font-mono text-caption text-muted-foreground">
          {detail}
        </code>
      ) : null}
      <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
        {onRetry ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
        {secondary}
      </div>
    </div>
  );
}
