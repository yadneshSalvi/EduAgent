import { Pulse, RouteLoading } from '@/components/shared/route-skeletons';

export default function NewTrackLoading() {
  return (
    <RouteLoading label="Opening the track wizard" className="h-dvh">
      <div className="flex h-16 items-center justify-between border-b px-6">
        <Pulse className="h-6 w-28" />
        <Pulse className="h-8 w-80 max-w-[45vw]" />
        <Pulse className="h-4 w-24" />
      </div>
      <div className="mx-auto flex w-full max-w-3xl flex-1 animate-pulse flex-col gap-6 p-10">
        <Pulse className="h-12 w-80 max-w-full" />
        <Pulse className="h-16 w-full" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Pulse className="h-24 rounded-lg border bg-surface" />
          <Pulse className="h-24 rounded-lg border bg-surface" />
          <Pulse className="h-24 rounded-lg border bg-surface" />
          <Pulse className="h-24 rounded-lg border bg-surface" />
        </div>
      </div>
    </RouteLoading>
  );
}
