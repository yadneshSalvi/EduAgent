import { Pulse, RouteLoading } from '@/components/shared/route-skeletons';

/** Mirrors TutorRoomView: h-14 top bar, chat column + workbench rail at lg. */
export default function TutorRoomLoading() {
  return (
    <RouteLoading label="Opening the tutor room">
      <div className="flex h-14 shrink-0 animate-pulse items-center gap-3 border-b bg-surface px-4 lg:px-6">
        <Pulse className="h-6 w-12 rounded-sm" />
        <Pulse className="h-5 w-56" />
        <div className="flex-1" />
        <Pulse className="h-10 w-24" />
      </div>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 flex-1 animate-pulse flex-col gap-4 p-6">
          <Pulse className="h-20 w-2/3 rounded-lg border bg-surface" />
          <Pulse className="ml-auto h-12 w-1/2 rounded-lg border bg-surface" />
          <Pulse className="h-28 w-3/4 rounded-lg border bg-surface" />
          <div className="flex-1" />
          <Pulse className="h-24 rounded-lg border bg-surface" />
        </div>
        <div className="hidden w-11 shrink-0 border-l bg-surface lg:block" />
      </div>
    </RouteLoading>
  );
}
