'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { z } from 'zod';
import {
  wsEventSchema,
  type ClientWsEvent,
  type MemoryCommit,
  type ThreadItem,
  type WsEvent,
} from '@eduagent/shared';
import { ApiError, getThreadItems, threadSocketUrl } from '@/lib/api';

/**
 * Turn state per thread (plans/04 §2): one hook owns the WS connection to
 * `GET /ws?threadId=` and reduces the WsEvent stream into renderable state.
 * Every inbound frame is parsed with the shared `wsEventSchema` — invalid
 * frames are console.warn'd and ignored, never rendered.
 */

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  /** Optimistic local send, not yet mirrored by the server. */
  pending?: boolean;
}

export interface ActivityChip {
  id: string;
  kind: 'exec' | 'tool';
  label: string;
  status: 'started' | 'completed' | 'failed';
}

export type TurnStatus = 'idle' | 'awaiting' | 'streaming';
export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'unauthenticated';
export type HistoryStatus = 'loading' | 'ready' | 'error';

export interface TurnStreamState {
  items: ChatMessage[];
  streamingItemId: string | null;
  streamingText: string;
  reasoningPreview: string;
  activityChips: ActivityChip[];
  turnStatus: TurnStatus;
  connection: ConnectionStatus;
  history: HistoryStatus;
  historyError: string | null;
  /** Commits seen on this thread socket (containers surface them as toasts). */
  commits: MemoryCommit[];
  error: { message: string; retryable: boolean } | null;
}

export const initialTurnStreamState: TurnStreamState = {
  items: [],
  streamingItemId: null,
  streamingText: '',
  reasoningPreview: '',
  activityChips: [],
  turnStatus: 'idle',
  connection: 'connecting',
  history: 'loading',
  historyError: null,
  commits: [],
  error: null,
};

export type TurnStreamAction =
  | { type: 'event'; event: WsEvent }
  | { type: 'send'; item: ChatMessage }
  | { type: 'history'; items: ChatMessage[] }
  | { type: 'history-loading' }
  | { type: 'history-error'; message: string }
  | { type: 'connection'; status: ConnectionStatus }
  /** Clear turn/chat state but keep the connection surface (dev-harness replay). */
  | { type: 'reset' };

/** Flush the in-flight streaming buffer into items (id-deduped). */
function flushStreaming(state: TurnStreamState): TurnStreamState {
  if (!state.streamingItemId || state.streamingText === '') {
    return { ...state, streamingItemId: null, streamingText: '' };
  }
  const flushed: ChatMessage = {
    id: state.streamingItemId,
    role: 'agent',
    text: state.streamingText,
  };
  return {
    ...state,
    items: upsertItem(state.items, flushed),
    streamingItemId: null,
    streamingText: '',
  };
}

function upsertItem(items: ChatMessage[], item: ChatMessage): ChatMessage[] {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
}

/**
 * Reconnect resync (plans/03 §7): server history is authoritative; keep only
 * local extras — WS-completed items the mirror hasn't flushed yet, and pending
 * optimistic sends whose text no server user-message matches.
 */
function mergeHistory(existing: ChatMessage[], server: ChatMessage[]): ChatMessage[] {
  const serverIds = new Set(server.map((item) => item.id));
  const serverUserTexts = new Set(
    server.filter((item) => item.role === 'user').map((item) => item.text),
  );
  const extras = existing.filter((item) => {
    if (serverIds.has(item.id)) return false;
    if (item.pending && serverUserTexts.has(item.text)) return false;
    return true;
  });
  return [...server, ...extras];
}

function applyActivity(
  chips: ActivityChip[],
  event: Extract<WsEvent, { type: 'activity' }>,
): ActivityChip[] {
  const chip: ActivityChip = {
    id: `${event.kind}:${event.label}:${chips.length}`,
    kind: event.kind,
    label: event.label,
    status: event.status,
  };
  if (event.status === 'started') return [...chips, chip];
  // completed/failed settle the most recent still-running chip with the same label.
  for (let i = chips.length - 1; i >= 0; i--) {
    const existing = chips[i];
    if (existing && existing.label === event.label && existing.status === 'started') {
      const next = chips.slice();
      next[i] = { ...existing, status: event.status };
      return next;
    }
  }
  // No matching started chip (e.g. joined mid-turn): show it settled.
  return [...chips, chip];
}

function applyEvent(state: TurnStreamState, event: WsEvent): TurnStreamState {
  switch (event.type) {
    case 'turn.started':
      return {
        ...state,
        turnStatus: 'awaiting',
        reasoningPreview: '',
        activityChips: [],
        error: null,
      };

    case 'reasoning.delta':
      return { ...state, reasoningPreview: state.reasoningPreview + event.text };

    case 'message.delta': {
      // A delta for a new item while another streams: flush the old one first.
      const base =
        state.streamingItemId && state.streamingItemId !== event.itemId
          ? flushStreaming(state)
          : state;
      return {
        ...base,
        streamingItemId: event.itemId,
        streamingText:
          base.streamingItemId === event.itemId ? base.streamingText + event.text : event.text,
        // The first real token collapses the reasoning preview (plans/05 §6.3).
        reasoningPreview: '',
        turnStatus: 'streaming',
      };
    }

    case 'message.completed': {
      const item: ChatMessage = { id: event.itemId, role: 'agent', text: event.text };
      const streamingMatched = state.streamingItemId === event.itemId;
      return {
        ...state,
        items: upsertItem(state.items, item),
        streamingItemId: streamingMatched ? null : state.streamingItemId,
        streamingText: streamingMatched ? '' : state.streamingText,
        // Turn continues (tools, commits, maybe another message) until turn.completed.
        turnStatus: 'awaiting',
      };
    }

    case 'activity':
      return { ...state, activityChips: applyActivity(state.activityChips, event) };

    case 'memory.commit':
      return { ...state, commits: [...state.commits, event.commit] };

    case 'turn.completed':
      return {
        ...flushStreaming(state),
        turnStatus: 'idle',
        reasoningPreview: '',
        activityChips: [],
      };

    case 'turn.error':
      return {
        ...flushStreaming(state),
        turnStatus: 'idle',
        reasoningPreview: '',
        error: { message: event.message, retryable: event.retryable },
      };

    // Workbench / grading / exam events are Phase 2 surfaces — parsed (so the
    // contract is enforced) but not rendered by the tutor room yet.
    case 'workbench.exercise':
    case 'workbench.quiz':
    case 'workbench.artifact':
    case 'assessment.recorded':
    case 'exercise.graded':
    case 'quiz.graded':
    case 'exam.created':
    case 'exam.graded':
      return state;
  }
}

export function turnStreamReducer(
  state: TurnStreamState,
  action: TurnStreamAction,
): TurnStreamState {
  switch (action.type) {
    case 'event':
      return applyEvent(state, action.event);
    case 'send':
      return {
        ...state,
        items: [...state.items, action.item],
        turnStatus: 'awaiting',
        error: null,
      };
    case 'history':
      return {
        ...state,
        items: mergeHistory(state.items, action.items),
        history: 'ready',
        historyError: null,
      };
    case 'history-loading':
      return { ...state, history: 'loading', historyError: null };
    case 'history-error':
      return { ...state, history: 'error', historyError: action.message };
    case 'connection':
      return { ...state, connection: action.status };
    case 'reset':
      return {
        ...initialTurnStreamState,
        connection: state.connection,
        history: state.history,
      };
  }
}

/** ItemMirror payload for `kind: "message"` rows (task #11 contract): `{text}`. */
const messagePayloadSchema = z.object({ text: z.string() });

export function threadItemToChatMessage(item: ThreadItem): ChatMessage | null {
  if (item.kind !== 'message') return null;
  const parsed = messagePayloadSchema.safeParse(item.payload);
  if (!parsed.success) {
    console.warn('thread item payload missing {text}, skipping', item.id);
    return null;
  }
  return { id: item.id, role: item.role, text: parsed.data.text };
}

/** Parse one raw WS frame; invalid frames → console.warn + null (never rendered). */
export function parseWsFrame(raw: unknown): WsEvent | null {
  let json: unknown = raw;
  if (typeof raw === 'string') {
    try {
      json = JSON.parse(raw);
    } catch {
      console.warn('ws: non-JSON frame ignored');
      return null;
    }
  }
  const parsed = wsEventSchema.safeParse(json);
  if (!parsed.success) {
    console.warn('ws: frame failed wsEventSchema, ignored', z.treeifyError(parsed.error));
    return null;
  }
  return parsed.data;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

export interface UseTurnStreamOptions {
  /** Fired for every memory.commit on this thread socket (toast surfacing). */
  onCommit?: (commit: MemoryCommit) => void;
}

export interface TurnStream {
  state: TurnStreamState;
  /** Sends `{type:'user.message', text}`; false if the socket isn't open. */
  send: (text: string) => boolean;
  /** Re-runs the history fetch (retry path for the error state). */
  refetchHistory: () => void;
}

export function useTurnStream(threadId: string, options?: UseTurnStreamOptions): TurnStream {
  const [state, dispatch] = useReducer(turnStreamReducer, initialTurnStreamState);
  const wsRef = useRef<WebSocket | null>(null);
  const onCommitRef = useRef(options?.onCommit);
  onCommitRef.current = options?.onCommit;

  const fetchHistory = useCallback(() => {
    dispatch({ type: 'history-loading' });
    getThreadItems(threadId)
      .then(({ items }) => {
        const messages = items
          .map(threadItemToChatMessage)
          .filter((item): item is ChatMessage => item !== null);
        dispatch({ type: 'history', items: messages });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Could not load the conversation history.';
        dispatch({ type: 'history-error', message });
      });
  }, [threadId]);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      dispatch({ type: 'connection', status: attempt === 0 ? 'connecting' : 'reconnecting' });
      const ws = new WebSocket(threadSocketUrl(threadId));
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        attempt = 0;
        dispatch({ type: 'connection', status: 'open' });
        // Initial load AND reconnect resync share one path: refetch items and
        // dedupe by itemId (plans/03 §7 — missed deltas are never replayed).
        fetchHistory();
      };

      ws.onmessage = (messageEvent) => {
        if (disposed) return;
        const event = parseWsFrame(messageEvent.data);
        if (!event) return;
        dispatch({ type: 'event', event });
        if (event.type === 'memory.commit') onCommitRef.current?.(event.commit);
      };

      ws.onclose = (closeEvent) => {
        if (disposed) return;
        wsRef.current = null;
        if (closeEvent.code === 4401) {
          // Unauthenticated (server auth handshake) — reconnecting won't help.
          dispatch({ type: 'connection', status: 'unauthenticated' });
          return;
        }
        attempt++;
        const backoff = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_CAP_MS);
        const jittered = backoff * (0.75 + Math.random() * 0.5);
        dispatch({ type: 'connection', status: 'reconnecting' });
        timer = setTimeout(connect, jittered);
      };
    };

    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [threadId, fetchHistory]);

  const send = useCallback((text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const event: ClientWsEvent = { type: 'user.message', text: trimmed };
    ws.send(JSON.stringify(event));
    dispatch({
      type: 'send',
      item: { id: `local-${crypto.randomUUID()}`, role: 'user', text: trimmed, pending: true },
    });
    return true;
  }, []);

  return { state, send, refetchHistory: fetchHistory };
}
