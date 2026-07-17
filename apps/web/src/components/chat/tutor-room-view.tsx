'use client';

import type { ReactNode } from 'react';
import { PanelRight, Square } from 'lucide-react';
import type { TurnStream } from '@/hooks/use-turn-stream';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/shared/error-state';
import { ChatInput } from './chat-input';
import { MessageList } from './message-list';
import { cn } from '@/lib/utils';

/**
 * Presentational tutor room (plans/04 §3), minus the workbench pane (Phase 2
 * — a collapsed right-rail stub holds its place). Driven either by the live
 * useTurnStream hook or the dev-harness replay driver — same reducer, same UI.
 */
interface TutorRoomViewProps {
  title: string;
  topicSlug: string | null;
  stream: TurnStream;
  onInterrupt: () => void;
  /** Extra topbar content (dev-harness controls). */
  topbarExtra?: ReactNode;
  emptyHint?: string;
}

function ConnectionDot({ connection }: { connection: TurnStream['state']['connection'] }) {
  const label =
    connection === 'open'
      ? 'connected'
      : connection === 'unauthenticated'
        ? 'signed out'
        : 'reconnecting';
  return (
    <span className="hidden items-center gap-1.5 font-mono text-caption text-muted-foreground md:flex">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          connection === 'open' && 'bg-success',
          (connection === 'connecting' || connection === 'reconnecting') && 'animate-pulse bg-warn',
          connection === 'unauthenticated' && 'bg-danger',
        )}
      />
      {label}
    </span>
  );
}

export function TutorRoomView({
  title,
  topicSlug,
  stream,
  onInterrupt,
  topbarExtra,
  emptyHint,
}: TutorRoomViewProps) {
  const { state, send, refetchHistory } = stream;
  const turnInFlight = state.turnStatus !== 'idle';

  const retryTurn = () => {
    const lastUser = [...state.items].reverse().find((item) => item.role === 'user');
    if (lastUser) send(lastUser.text);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-4 lg:px-6">
        {topicSlug ? (
          <Badge variant="accent" className="font-mono lowercase">
            {topicSlug}
          </Badge>
        ) : null}
        <h1 className="min-w-0 truncate text-body font-medium">{title}</h1>
        <div className="flex-1" />
        {topbarExtra}
        <ConnectionDot connection={state.connection} />
        <Button
          size="sm"
          variant="outline"
          disabled={!turnInFlight}
          onClick={onInterrupt}
          className="gap-1.5"
          title="Stop the current turn (Esc)"
        >
          <Square className="size-3 fill-current" aria-hidden />
          Stop
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {state.history === 'error' ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <ErrorState
                title="The tutor room can't load yet"
                description="The conversation history didn't come back from the agent host. Your memory is intact — this screen retries against the same thread."
                detail={state.historyError ?? undefined}
                onRetry={refetchHistory}
              />
            </div>
          ) : (
            <MessageList state={state} onRetryTurn={retryTurn} emptyHint={emptyHint} />
          )}
          <ChatInput
            onSend={send}
            onInterrupt={onInterrupt}
            turnInFlight={turnInFlight}
            connection={state.connection}
          />
        </div>

        {/* Workbench (Exercise · Quiz · Artifact) lands in Phase 2 — collapsed rail stub. */}
        <aside
          className="hidden w-11 shrink-0 flex-col items-center gap-3 border-l bg-surface py-4 xl:flex"
          aria-label="Workbench (coming in Phase 2)"
          title="Workbench — Exercise · Quiz · Artifact (Phase 2)"
        >
          <PanelRight className="size-4 text-muted-foreground/70" aria-hidden />
          <span
            className="font-mono text-caption tracking-wide text-muted-foreground/70"
            style={{ writingMode: 'vertical-rl' }}
          >
            workbench
          </span>
        </aside>
      </div>
    </div>
  );
}
