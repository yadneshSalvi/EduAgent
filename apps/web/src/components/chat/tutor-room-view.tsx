'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Square } from 'lucide-react';
import type { SubmitQuizRequest } from '@eduagent/shared';
import type { TurnStream } from '@/hooks/use-turn-stream';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/shared/error-state';
import { WorkbenchPanel } from '@/components/workbench/workbench-panel';
import { ChatInput } from './chat-input';
import { MessageList } from './message-list';
import { cn } from '@/lib/utils';

/**
 * Presentational tutor room (plans/04 §3): chat (55%) + workbench (45%,
 * stacked under the chat below lg — Tailwind's md: starts AT 768px, so a
 * 768px tablet would squeeze side-by-side under md:, QA finding F5). Driven
 * either by the live useTurnStream hook or the dev-harness replay driver —
 * same reducer, same UI. Submission transports are injected the same way
 * (REST vs scripted replay).
 */
interface TutorRoomViewProps {
  title: string;
  topicSlug: string | null;
  badgeText?: string;
  /** Keys the per-thread workbench collapsed-state persistence. */
  threadId: string;
  stream: TurnStream;
  onInterrupt: () => void;
  onSubmitExercise: (exerciseId: string, code: string) => Promise<unknown>;
  onSubmitQuiz: (quizId: string, answers: SubmitQuizRequest['answers']) => Promise<unknown>;
  /** Extra topbar content (dev-harness controls). */
  topbarExtra?: ReactNode;
  emptyHint?: string;
  trackContext?: { slug: string; threadId: string };
}

function ConnectionDot({ connection }: { connection: TurnStream['state']['connection'] }) {
  const label =
    connection === 'open'
      ? 'connected'
      : connection === 'unauthenticated'
        ? 'signed out'
        : connection === 'not-found'
          ? 'not found'
          : connection === 'failed'
            ? 'offline'
            : 'reconnecting';
  return (
    <span className="hidden items-center gap-1.5 font-mono text-caption text-muted-foreground md:flex">
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          connection === 'open' && 'bg-success',
          (connection === 'connecting' || connection === 'reconnecting') && 'animate-pulse bg-warn',
          (connection === 'unauthenticated' ||
            connection === 'not-found' ||
            connection === 'failed') &&
            'bg-danger',
        )}
      />
      {label}
    </span>
  );
}

export function TutorRoomView({
  title,
  topicSlug,
  badgeText,
  threadId,
  stream,
  onInterrupt,
  onSubmitExercise,
  onSubmitQuiz,
  topbarExtra,
  emptyHint,
  trackContext,
}: TutorRoomViewProps) {
  const { state, send, refetchHistory, dispatch } = stream;
  const turnInFlight = state.turnStatus !== 'idle';
  const connectionLost = state.connection === 'not-found' || state.connection === 'failed';

  const retryTurn = () => {
    const lastUser = [...state.items].reverse().find((item) => item.role === 'user');
    if (lastUser) send(lastUser.text);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-surface px-4 lg:px-6">
        {(badgeText ?? topicSlug) ? (
          <Badge variant="accent" className="font-mono lowercase">
            {badgeText ?? topicSlug}
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

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {state.connection === 'not-found' ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <ErrorState
                title="This session doesn't exist"
                description="There's no learning session at this address — it may belong to another learner or the link is stale. Your own memory and sessions are untouched."
                secondary={
                  <Button asChild variant="outline">
                    <Link href="/app/learn">Back to your sessions</Link>
                  </Button>
                }
              />
            </div>
          ) : state.connection === 'failed' ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <ErrorState
                title="Can't reach the tutor"
                description="The live connection kept failing. Your memory is intact — reload to try again."
                onRetry={() => window.location.reload()}
              />
            </div>
          ) : state.history === 'error' ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <ErrorState
                title="The tutor room can't load yet"
                description="The conversation history didn't come back from the agent host. Your memory is intact — this screen retries against the same thread."
                detail={state.historyError ?? undefined}
                onRetry={refetchHistory}
              />
            </div>
          ) : (
            <MessageList
              state={state}
              onRetryTurn={retryTurn}
              emptyHint={emptyHint}
              trackContext={trackContext}
            />
          )}
          {state.connection === 'not-found' || state.connection === 'failed' ? null : (
            <ChatInput
              onSend={send}
              onInterrupt={onInterrupt}
              turnInFlight={turnInFlight}
              connection={state.connection}
            />
          )}
        </div>

        {connectionLost ? null : (
          <WorkbenchPanel
            threadId={threadId}
            workbench={state.workbench}
            dispatch={dispatch}
            onSubmitExercise={onSubmitExercise}
            onSubmitQuiz={onSubmitQuiz}
          />
        )}
      </div>
    </div>
  );
}
