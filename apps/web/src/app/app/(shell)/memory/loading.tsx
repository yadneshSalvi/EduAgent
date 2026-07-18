import { Pulse, RouteLoading } from '@/components/shared/route-skeletons';

/** Mirrors MemoryExplorer: toolbar + tree · viewer · history 3-col grid. */
export default function MemoryLoading() {
  return (
    <RouteLoading label="Loading your memory">
      <div className="flex animate-pulse items-center gap-4 border-b px-6 py-3">
        <Pulse className="h-6 w-40" />
        <div className="flex-1" />
        <Pulse className="h-10 w-40" />
      </div>
      <div className="grid min-h-0 flex-1 animate-pulse grid-cols-1 lg:grid-cols-[240px_1fr_260px]">
        <div className="hidden space-y-2 border-r p-4 lg:block">
          {Array.from({ length: 8 }, (_, i) => (
            <Pulse key={i} className="h-4 rounded-sm" />
          ))}
        </div>
        <div className="space-y-3 p-6">
          {Array.from({ length: 10 }, (_, i) => (
            <Pulse key={i} className="h-4 rounded-sm" style={{ width: `${90 - (i % 4) * 15}%` }} />
          ))}
        </div>
        <div className="hidden space-y-3 border-l p-4 lg:block">
          {Array.from({ length: 6 }, (_, i) => (
            <Pulse key={i} className="h-12 rounded-md" />
          ))}
        </div>
      </div>
    </RouteLoading>
  );
}
