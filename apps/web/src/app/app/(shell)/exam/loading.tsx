import { PageHeaderSkeleton, Pulse, RouteLoading } from '@/components/shared/route-skeletons';

/** Mirrors ExamSetup: centered max-w-2xl setup card + history rows. */
export default function ExamLoading() {
  return (
    <RouteLoading label="Loading exams">
      <PageHeaderSkeleton />
      <div className="mx-auto flex w-full max-w-2xl animate-pulse flex-col gap-4 p-8">
        <Pulse className="h-96 rounded-lg border bg-surface" />
        <Pulse className="h-12 rounded-lg border bg-surface" />
        <Pulse className="h-12 rounded-lg border bg-surface" />
      </div>
    </RouteLoading>
  );
}
