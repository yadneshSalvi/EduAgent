import { PageHeaderSkeleton, Pulse, RouteLoading } from '@/components/shared/route-skeletons';

export default function SettingsLoading() {
  return (
    <RouteLoading label="Loading settings">
      <PageHeaderSkeleton />
      <div className="flex flex-1 animate-pulse items-center justify-center p-8">
        <Pulse className="h-64 w-full max-w-md rounded-lg border bg-surface" />
      </div>
    </RouteLoading>
  );
}
