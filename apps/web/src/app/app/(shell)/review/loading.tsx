import { Pulse, RouteLoading } from '@/components/shared/route-skeletons';

/** Mirrors ReviewFlow: its own px-8 py-6 header + centered max-w-xl queue. */
export default function ReviewLoading() {
  return (
    <RouteLoading label="Loading your review queue">
      <div className="flex animate-pulse flex-col gap-2 border-b px-8 py-6">
        <Pulse className="h-9 w-32" />
        <Pulse className="h-4 w-96 max-w-full rounded-sm" />
      </div>
      <div className="flex flex-1 items-start justify-center p-8">
        <div className="flex w-full max-w-xl animate-pulse flex-col gap-4">
          <Pulse className="h-28 rounded-lg border bg-surface" />
          <Pulse className="h-14 rounded-lg border bg-surface" />
          <Pulse className="h-14 rounded-lg border bg-surface" />
        </div>
      </div>
    </RouteLoading>
  );
}
