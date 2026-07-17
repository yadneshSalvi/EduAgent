'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import type { ConnectionStatus } from '@/hooks/use-turn-stream';
import { cn } from '@/lib/utils';

/**
 * Chat input (plans/04 §3): multiline, ⌘↵ sends, Esc interrupts the streaming
 * turn, `/` focuses from anywhere on the page.
 */
interface ChatInputProps {
  onSend: (text: string) => boolean;
  onInterrupt: () => void;
  /** A turn is in flight — Esc interrupts it. */
  turnInFlight: boolean;
  connection: ConnectionStatus;
  placeholder?: string;
}

const MAX_HEIGHT_PX = 180;

export function ChatInput({
  onSend,
  onInterrupt,
  turnInFlight,
  connection,
  placeholder = 'Message the tutor…',
}: ChatInputProps) {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const resize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, []);

  // `/` focuses the input from anywhere (unless already typing somewhere).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      textareaRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const submit = useCallback(() => {
    if (onSend(text)) {
      setText('');
      requestAnimationFrame(resize);
    }
  }, [onSend, text, resize]);

  const disconnected = connection !== 'open';

  return (
    <div className="border-t bg-surface px-4 py-3 lg:px-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-1.5">
        <div
          className={cn(
            'flex items-end gap-2 rounded-lg border bg-background px-3 py-2 transition-colors duration-150',
            'focus-within:border-ring',
          )}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label="Message the tutor"
            onChange={(event) => {
              setText(event.target.value);
              resize();
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              } else if (event.key === 'Escape' && turnInFlight) {
                event.preventDefault();
                onInterrupt();
              }
            }}
            className="max-h-[180px] flex-1 resize-none bg-transparent text-body outline-none placeholder:text-muted-foreground/70 focus-visible:outline-none"
          />
          <button
            type="button"
            onClick={submit}
            disabled={text.trim() === '' || disconnected}
            aria-label="Send message (⌘↵)"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-150',
              text.trim() !== '' && !disconnected
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'bg-surface-2 text-muted-foreground',
            )}
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </div>
        <div className="flex items-center justify-between px-1 font-mono text-caption text-muted-foreground/80">
          <span aria-live="polite">
            {connection === 'reconnecting' ? (
              <span className="flex items-center gap-1.5 text-warn">
                <span className="size-1.5 animate-pulse rounded-full bg-warn" aria-hidden />
                Reconnecting to the tutor… your memory is intact.
              </span>
            ) : connection === 'unauthenticated' ? (
              <span className="text-danger">Session expired — sign in again to continue.</span>
            ) : null}
          </span>
          <span className="hidden sm:inline">⌘↵ send · / focus · esc stop</span>
        </div>
      </div>
    </div>
  );
}
