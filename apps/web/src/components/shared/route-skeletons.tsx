import { cn } from '@/lib/utils';

/**
 * Route-level loading skeletons (plans/04 §12, 05 §10): each mirrors its
 * screen's final geometry so navigation never shifts layout. These render in
 * loading.tsx during route-chunk loads; the views' own React Query skeletons
 * take over once the client mounts — keep both in sync when a layout changes.
 */

export function Pulse({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={cn('rounded-md bg-surface-2', className)} style={style} />;
}

/** Mirrors shared/PageHeader: border-b px-8 py-6, h1 + description line. */
export function PageHeaderSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-2 border-b px-8 py-6">
      <Pulse className="h-9 w-48" />
      <Pulse className="h-4 w-96 max-w-full rounded-sm" />
    </div>
  );
}

export function RouteLoading({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <span className="sr-only">{label}</span>
      <div aria-hidden className="flex min-h-0 flex-1 flex-col">
        {children}
      </div>
    </div>
  );
}

/** Mirrors DashboardView's grid (keep in sync with DashboardSkeleton there). */
export function DashboardRouteSkeleton() {
  return (
    <RouteLoading label="Loading your dashboard">
      <div className="flex animate-pulse flex-col gap-6 p-8">
        <div className="flex items-end justify-between gap-6">
          <div className="flex flex-col gap-3">
            <Pulse className="h-9 w-72" />
            <Pulse className="h-4 w-52 rounded-sm" />
          </div>
          <Pulse className="h-12 w-64 rounded-lg" />
        </div>
        <div className="grid items-start gap-6 lg:grid-cols-12">
          <div className="flex flex-col gap-6 lg:col-span-4">
            <div className="h-[500px] rounded-lg border bg-surface" />
            <div className="h-[500px] rounded-lg border bg-surface" />
            <div className="h-[200px] rounded-lg border bg-surface" />
          </div>
          <div className="flex flex-col gap-6 lg:col-span-8">
            <div className="h-[230px] rounded-lg border bg-surface" />
            <div className="h-[380px] rounded-lg border bg-surface" />
            <div className="h-[640px] rounded-lg border bg-surface" />
          </div>
        </div>
      </div>
    </RouteLoading>
  );
}
