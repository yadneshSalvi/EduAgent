import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** Mono metadata line (thread ids, shas — memory speaks terminal, 05 §1). */
  meta?: string;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, meta, actions, className }: PageHeaderProps) {
  return (
    <header className={cn('flex items-start justify-between gap-6 border-b px-8 py-6', className)}>
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="font-display text-h2 font-medium tracking-tight">{title}</h1>
        {description ? <p className="text-body-sm text-muted-foreground">{description}</p> : null}
        {meta ? (
          <p className="truncate font-mono text-caption text-muted-foreground">{meta}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </header>
  );
}
