'use client';

import { memo } from 'react';
import type { ChatMessage } from '@/hooks/use-turn-stream';
import { Markdown } from './markdown';
import { cn } from '@/lib/utils';

/**
 * One chat item (plans/04 §3). Agent messages are scholar-voice prose (full
 * width, markdown); user messages sit right-aligned in a quiet bubble.
 */
export const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
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
