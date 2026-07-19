import { Pulse, RouteLoading } from '@/components/shared/route-skeletons';

export default function DashboardLoading() {
  return (
    <RouteLoading label="Loading your tracks">
      <div className="flex animate-pulse flex-col gap-6 p-8">
        <div className="flex items-end justify-between gap-4">
          <div className="space-y-2">
            <Pulse className="h-9 w-64" />
            <Pulse className="h-4 w-48" />
          </div>
          <Pulse className="h-10 w-32" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Pulse className="h-48 rounded-lg border bg-surface" />
          <Pulse className="h-48 rounded-lg border bg-surface" />
        </div>
        <Pulse className="h-14 rounded-lg border bg-surface" />
      </div>
    </RouteLoading>
  );
}
