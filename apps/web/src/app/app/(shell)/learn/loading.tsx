import { PageHeaderSkeleton, Pulse, RouteLoading } from '@/components/shared/route-skeletons';

/** Mirrors LearnPicker: continue slot + two topic cards (max-w-2xl, p-8). */
export default function LearnLoading() {
  return (
    <RouteLoading label="Loading topics">
      <PageHeaderSkeleton />
      <div className="flex animate-pulse flex-col gap-8 p-8">
        <div className="flex flex-col gap-3">
          <Pulse className="h-4 w-20 rounded-sm" />
          <Pulse className="h-[74px] max-w-2xl rounded-lg border bg-surface" />
        </div>
        <div className="flex flex-col gap-3">
          <Pulse className="h-4 w-16 rounded-sm" />
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            <Pulse className="h-44 rounded-lg border bg-surface" />
            <Pulse className="h-44 rounded-lg border bg-surface" />
          </div>
        </div>
      </div>
    </RouteLoading>
  );
}
