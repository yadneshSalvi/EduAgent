'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { MemoryCommit } from '@eduagent/shared';
import {
  initialTurnStreamState,
  turnStreamReducer,
  type TurnStream,
  type TurnStreamAction,
} from './use-turn-stream';
import type { ReplayStep } from '@/lib/fixtures/turn-preview';

/**
 * Dev-harness driver (plans task 1C §7): replays a scripted WsEvent sequence
 * through the SAME reducer the live hook uses, so the tutor-room components
 * and the commit toast can be built and screenshot-verified before the WS
 * gateway (task #11) lands. Not used in production paths.
 */
export interface ReplayTurnStream extends TurnStream {
  /**
   * Replays a script from its start (cancels any in-flight replay). By
   * default the chat state resets first; pass {reset:false} to append —
   * that's how scripted replies continue a conversation.
   */
  replay: (script: ReplayStep[], options?: { reset?: boolean }) => void;
}

export function useReplayTurnStream(
  initialScript: ReplayStep[],
  options?: {
    onCommit?: (commit: MemoryCommit) => void;
    /** Called on each user send; returning a script replays it as the reply. */
    getReply?: () => ReplayStep[] | undefined;
  },
): ReplayTurnStream {
  const [state, dispatch] = useReducer(turnStreamReducer, {
    ...initialTurnStreamState,
    connection: 'open' as const,
    history: 'ready' as const,
  });
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const onCommitRef = useRef(options?.onCommit);
  onCommitRef.current = options?.onCommit;
  const getReplyRef = useRef(options?.getReply);
  getReplyRef.current = options?.getReply;

  const cancel = useCallback(() => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  }, []);

  const replay = useCallback(
    (script: ReplayStep[], options?: { reset?: boolean }) => {
      cancel();
      if (options?.reset !== false) dispatch({ type: 'reset' });
      for (const step of script) {
        const timer = setTimeout(() => {
          const action: TurnStreamAction = { type: 'event', event: step.event };
          dispatch(action);
          if (step.event.type === 'memory.commit') onCommitRef.current?.(step.event.commit);
        }, step.at);
        timersRef.current.push(timer);
      }
    },
    [cancel],
  );

  const initialScriptRef = useRef(initialScript);
  useEffect(() => {
    replay(initialScriptRef.current);
    return cancel;
  }, [replay, cancel]);

  const send = useCallback(
    (text: string): boolean => {
      const trimmed = text.trim();
      if (trimmed === '') return false;
      dispatch({
        type: 'send',
        item: { id: `local-${crypto.randomUUID()}`, role: 'user', text: trimmed, pending: true },
      });
      const reply = getReplyRef.current?.();
      if (reply) replay(reply, { reset: false });
      return true;
    },
    [replay],
  );

  return { state, send, refetchHistory: () => {}, replay };
}
