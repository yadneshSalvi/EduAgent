'use client';

import { useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import type { TurnStreamState } from '@/hooks/use-turn-stream';
import { Button } from '@/components/ui/button';
import { ActivityChips } from './activity-chips';
import { MessageBubble } from './message-bubble';
import { ReasoningPreview } from './reasoning-preview';
import { StreamingMessage } from './streaming-message';

/**
 * The chat column body: mirrored history + the live turn (reasoning preview,
 * activity chips, streaming message). Sticks to the bottom unless the reader
 * scrolled up. Streaming output sits in an aria-live=polite region (05 §9).
 */
function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 text-body-sm text-muted-foreground">
      <span className="chip-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      <span className="font-serif italic">The tutor is thinking…</span>
    </div>
  );
}

interface MessageListProps {
  state: TurnStreamState;
  /** Re-sends the last user message after a retryable turn.error. */
  onRetryTurn?: () => void;
  /** Copy shown when the thread is empty and nothing is in flight yet. */
  emptyHint?: string;
}

const NEAR_BOTTOM_PX = 96;

export function MessageList({ state, onRetryTurn, emptyHint }: MessageListProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = containerRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.items, state.streamingText, state.reasoningPreview, state.activityChips, state.turnStatus]);

  const showEmpty =
    state.items.length === 0 &&
    state.turnStatus === 'idle' &&
    state.streamingText === '' &&
    state.history === 'ready';

  return (
    <div
      ref={containerRef}
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
      }}
      className="flex-1 overflow-y-auto px-4 py-6 lg:px-6"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-5">
        {state.items.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {showEmpty ? (
          <p className="py-10 text-center font-serif italic text-body-sm text-muted-foreground">
            {emptyHint ?? 'The tutor opens every session — it will greet you in a moment.'}
          </p>
        ) : null}

        <ActivityChips chips={state.activityChips} />
        <ReasoningPreview text={state.reasoningPreview} />

        <div aria-live="polite">
          {state.streamingText !== '' ? (
            <StreamingMessage text={state.streamingText} />
          ) : state.turnStatus === 'awaiting' ? (
            <ThinkingIndicator />
          ) : null}
        </div>

        {state.error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3"
          >
            <p className="text-body-sm">{state.error.message}</p>
            {state.error.retryable && onRetryTurn ? (
              <Button size="sm" variant="outline" onClick={onRetryTurn} className="shrink-0 gap-1.5">
                <RefreshCw className="size-3.5" aria-hidden />
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
