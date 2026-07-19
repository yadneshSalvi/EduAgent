import { Pulse, RouteLoading } from '@/components/shared/route-skeletons';

export default function RoadmapLoading() {
  return (
    <RouteLoading label="Loading the roadmap">
      <div className="flex animate-pulse flex-col gap-3 border-b p-6">
        <Pulse className="h-8 w-64" />
        <Pulse className="h-4 w-96 max-w-full" />
        <Pulse className="h-1.5 w-full" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-8">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex gap-4">
            <Pulse className="mt-4 size-4 rounded-full" />
            <Pulse className="h-32 flex-1 rounded-lg border bg-surface" />
          </div>
        ))}
      </div>
    </RouteLoading>
  );
}
