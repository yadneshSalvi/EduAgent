'use client';

import { memo } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '@/hooks/use-turn-stream';
import { Markdown } from './markdown';
import { cn } from '@/lib/utils';
import { SessionWrapCard } from '@/components/tracks/session-wrap-card';

/**
 * One chat item (plans/04 §3). Agent messages are scholar-voice prose (full
 * width, markdown); user messages sit right-aligned in a quiet bubble.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  trackContext,
}: {
  message: ChatMessage;
  trackContext?: { slug: string; threadId: string };
}) {
  if (message.kind === 'reasoning') {
    return (
      <details className="group rounded-md border-l-2 border-border pl-3">
        <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1.5 font-mono text-caption text-muted-foreground marker:content-none">
          <ChevronRight
            className="size-3.5 transition-transform duration-150 group-open:rotate-90"
            aria-hidden
          />
          · thinking
        </summary>
        <p className="pb-3 whitespace-pre-wrap break-words font-serif italic text-body-sm text-muted-foreground">
          {message.text}
        </p>
      </details>
    );
  }
  if (message.kind === 'wrap') {
    return trackContext ? (
      <SessionWrapCard
        message={message}
        trackSlug={trackContext.slug}
        threadId={trackContext.threadId}
      />
    ) : (
      <CardFallback summary={message.wrap.summary_md} />
    );
  }
  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[85%] whitespace-pre-wrap rounded-lg rounded-br-sm border bg-surface-2 px-4 py-2.5 text-body',
            message.pending && 'opacity-80',
          )}
        >
          {message.text}
        </div>
      </div>
    );
  }
  if (message.role === 'system') {
    // The server mirrors the auto-greeting trigger as a literal '[session-start]'
    // system row (ThreadManager.GREETING_INPUT) — show a human caption, not the token.
    const caption = message.text === '[session-start]' ? 'Session started' : message.text;
    return <p className="text-center text-caption text-muted-foreground">{caption}</p>;
  }
  return <Markdown content={message.text} />;
});

function CardFallback({ summary }: { summary: string }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-surface p-5">
      <h2 className="font-display text-h3 font-medium">Good stopping point.</h2>
      <p className="mt-2 whitespace-pre-wrap text-body-sm text-muted-foreground">{summary}</p>
    </div>
  );
}
