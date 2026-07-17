import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wsEventSchema, type ThreadItem, type WsEvent } from '@eduagent/shared';
import {
  initialTurnStreamState,
  parseWsFrame,
  threadItemToChatMessage,
  turnStreamReducer,
  type ChatMessage,
  type TurnStreamState,
} from './use-turn-stream';
import {
  GREETING_COMMIT,
  errorTurnScript,
  greetingTurnScript,
  onboardingGreetingScript,
  onboardingReplyScripts,
  replyTurnScript,
} from '@/lib/fixtures/turn-preview';

function applyEvents(state: TurnStreamState, events: WsEvent[]): TurnStreamState {
  return events.reduce((s, event) => turnStreamReducer(s, { type: 'event', event }), state);
}

describe('fixtures', () => {
  it('every fixture event conforms to the shared wsEventSchema', () => {
    const scripts = [
      greetingTurnScript,
      replyTurnScript,
      errorTurnScript,
      onboardingGreetingScript,
      ...onboardingReplyScripts,
    ];
    for (const script of scripts) {
      for (const step of script) {
        const parsed = wsEventSchema.safeParse(step.event);
        expect(parsed.success, JSON.stringify(step.event).slice(0, 120)).toBe(true);
      }
    }
  });

  it('fixture scripts are time-ordered', () => {
    for (const script of [greetingTurnScript, replyTurnScript, errorTurnScript]) {
      for (let i = 1; i < script.length; i++) {
        expect(script[i]?.at ?? 0).toBeGreaterThanOrEqual(script[i - 1]?.at ?? 0);
      }
    }
  });
});

describe('turnStreamReducer', () => {
  it('turn.started → awaiting, clears chips/reasoning/error', () => {
    const dirty: TurnStreamState = {
      ...initialTurnStreamState,
      reasoningPreview: 'old',
      activityChips: [{ id: 'x', kind: 'exec', label: 'old', status: 'completed' }],
      error: { message: 'boom', retryable: true },
    };
    const state = applyEvents(dirty, [{ type: 'turn.started', threadId: 't1' }]);
    expect(state.turnStatus).toBe('awaiting');
    expect(state.reasoningPreview).toBe('');
    expect(state.activityChips).toEqual([]);
    expect(state.error).toBeNull();
  });

  it('reasoning accumulates, then collapses on the first message token', () => {
    let state = applyEvents(initialTurnStreamState, [
      { type: 'turn.started', threadId: 't1' },
      { type: 'reasoning.delta', text: 'thinking ' },
      { type: 'reasoning.delta', text: 'harder…' },
    ]);
    expect(state.reasoningPreview).toBe('thinking harder…');
    expect(state.turnStatus).toBe('awaiting');

    state = applyEvents(state, [{ type: 'message.delta', itemId: 'm1', text: 'Hello' }]);
    expect(state.reasoningPreview).toBe('');
    expect(state.turnStatus).toBe('streaming');
    expect(state.streamingText).toBe('Hello');
  });

  it('message deltas accumulate per itemId; a new itemId flushes the previous one', () => {
    let state = applyEvents(initialTurnStreamState, [
      { type: 'message.delta', itemId: 'm1', text: 'part one' },
      { type: 'message.delta', itemId: 'm1', text: ' and two' },
    ]);
    expect(state.streamingText).toBe('part one and two');

    state = applyEvents(state, [{ type: 'message.delta', itemId: 'm2', text: 'next' }]);
    expect(state.items).toEqual([{ id: 'm1', role: 'agent', text: 'part one and two' }]);
    expect(state.streamingItemId).toBe('m2');
    expect(state.streamingText).toBe('next');
  });

  it('message.completed upserts the item and clears the matching stream', () => {
    let state = applyEvents(initialTurnStreamState, [
      { type: 'message.delta', itemId: 'm1', text: 'streamed tail lost ' },
    ]);
    state = applyEvents(state, [{ type: 'message.completed', itemId: 'm1', text: 'full text' }]);
    expect(state.items).toEqual([{ id: 'm1', role: 'agent', text: 'full text' }]);
    expect(state.streamingText).toBe('');
    expect(state.streamingItemId).toBeNull();
    expect(state.turnStatus).toBe('awaiting');
    // No duplicate on repeat (WS + history race).
    state = applyEvents(state, [{ type: 'message.completed', itemId: 'm1', text: 'full text' }]);
    expect(state.items).toHaveLength(1);
  });

  it('activity events pair started→completed on the same chip', () => {
    let state = applyEvents(initialTurnStreamState, [
      { type: 'activity', kind: 'exec', label: 'running tests', status: 'started' },
      { type: 'activity', kind: 'tool', label: 'updating memory', status: 'started' },
    ]);
    expect(state.activityChips).toHaveLength(2);

    state = applyEvents(state, [
      { type: 'activity', kind: 'exec', label: 'running tests', status: 'completed' },
    ]);
    expect(state.activityChips).toHaveLength(2);
    expect(state.activityChips[0]?.status).toBe('completed');
    expect(state.activityChips[1]?.status).toBe('started');
  });

  it('a settled activity with no started chip still shows up', () => {
    const state = applyEvents(initialTurnStreamState, [
      { type: 'activity', kind: 'exec', label: 'late join', status: 'completed' },
    ]);
    expect(state.activityChips).toEqual([
      expect.objectContaining({ label: 'late join', status: 'completed' }),
    ]);
  });

  it('turn.completed flushes an unfinished stream and resets turn state', () => {
    let state = applyEvents(initialTurnStreamState, [
      { type: 'turn.started', threadId: 't1' },
      { type: 'message.delta', itemId: 'm1', text: 'dangling' },
      { type: 'turn.completed', threadId: 't1' },
    ]);
    expect(state.items).toEqual([{ id: 'm1', role: 'agent', text: 'dangling' }]);
    expect(state.turnStatus).toBe('idle');
    expect(state.streamingText).toBe('');
    expect(state.activityChips).toEqual([]);
    // idempotent when nothing is streaming
    state = applyEvents(state, [{ type: 'turn.completed', threadId: 't1' }]);
    expect(state.items).toHaveLength(1);
  });

  it('turn.error surfaces message + retryable and ends the turn', () => {
    const state = applyEvents(initialTurnStreamState, [
      { type: 'turn.started', threadId: 't1' },
      { type: 'turn.error', message: 'lost connection', retryable: true },
    ]);
    expect(state.error).toEqual({ message: 'lost connection', retryable: true });
    expect(state.turnStatus).toBe('idle');
  });

  it('memory.commit is collected (and does not disturb the stream)', () => {
    const state = applyEvents(initialTurnStreamState, [
      { type: 'message.delta', itemId: 'm1', text: 'streaming…' },
      { type: 'memory.commit', commit: GREETING_COMMIT },
    ]);
    expect(state.commits).toEqual([GREETING_COMMIT]);
    expect(state.streamingText).toBe('streaming…');
  });

  it('send appends an optimistic pending item and clears prior errors', () => {
    const errored: TurnStreamState = {
      ...initialTurnStreamState,
      error: { message: 'x', retryable: true },
    };
    const item: ChatMessage = { id: 'local-1', role: 'user', text: 'hi', pending: true };
    const state = turnStreamReducer(errored, { type: 'send', item });
    expect(state.items).toEqual([item]);
    expect(state.turnStatus).toBe('awaiting');
    expect(state.error).toBeNull();
  });

  describe('history merge (reconnect resync)', () => {
    const serverHistory: ChatMessage[] = [
      { id: 'srv-1', role: 'agent', text: 'greeting' },
      { id: 'srv-2', role: 'user', text: 'my answer' },
      { id: 'srv-3', role: 'agent', text: 'follow-up' },
    ];

    it('dedupes by itemId — WS-completed items already in history collapse', () => {
      let state = applyEvents(initialTurnStreamState, [
        { type: 'message.completed', itemId: 'srv-1', text: 'greeting' },
        { type: 'message.completed', itemId: 'srv-3', text: 'follow-up' },
      ]);
      state = turnStreamReducer(state, { type: 'history', items: serverHistory });
      expect(state.items.map((i) => i.id)).toEqual(['srv-1', 'srv-2', 'srv-3']);
      expect(state.history).toBe('ready');
    });

    it('drops pending optimistic sends the server already mirrored (by text)', () => {
      let state = turnStreamReducer(initialTurnStreamState, {
        type: 'send',
        item: { id: 'local-abc', role: 'user', text: 'my answer', pending: true },
      });
      state = turnStreamReducer(state, { type: 'history', items: serverHistory });
      expect(state.items.map((i) => i.id)).toEqual(['srv-1', 'srv-2', 'srv-3']);
    });

    it('keeps local extras the mirror has not flushed yet', () => {
      let state = applyEvents(initialTurnStreamState, [
        { type: 'message.completed', itemId: 'ws-only', text: 'not mirrored yet' },
      ]);
      state = turnStreamReducer(state, { type: 'history', items: serverHistory });
      expect(state.items.map((i) => i.id)).toEqual(['srv-1', 'srv-2', 'srv-3', 'ws-only']);
    });
  });

  it('replaying the whole greeting fixture lands the expected final state', () => {
    const state = applyEvents(
      initialTurnStreamState,
      greetingTurnScript.map((step) => step.event),
    );
    expect(state.turnStatus).toBe('idle');
    expect(state.streamingText).toBe('');
    expect(state.reasoningPreview).toBe('');
    expect(state.items).toHaveLength(1);
    expect(state.items[0]?.id).toBe('item-greeting-01');
    expect(state.items[0]?.text).toContain('LEFT JOIN orders o');
    expect(state.commits).toEqual([GREETING_COMMIT]);
    expect(state.error).toBeNull();
  });
});

describe('parseWsFrame', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('parses a valid frame', () => {
    const frame = JSON.stringify({ type: 'turn.started', threadId: 't1' });
    expect(parseWsFrame(frame)).toEqual({ type: 'turn.started', threadId: 't1' });
  });

  it('ignores non-JSON frames with a warning', () => {
    expect(parseWsFrame('pong')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('ignores frames that fail the schema (unknown/invented events)', () => {
    expect(parseWsFrame(JSON.stringify({ type: 'made.up', foo: 1 }))).toBeNull();
    expect(parseWsFrame(JSON.stringify({ type: 'message.delta', itemId: '' }))).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});

describe('threadItemToChatMessage', () => {
  const base: Omit<ThreadItem, 'kind' | 'payload'> = {
    id: 'i1',
    codexItemId: null,
    role: 'agent',
    createdAt: '2026-07-17T12:00:00Z',
  };

  it('maps message items with {text} payloads', () => {
    const item: ThreadItem = { ...base, kind: 'message', payload: { text: 'hello' } };
    expect(threadItemToChatMessage(item)).toEqual({ id: 'i1', role: 'agent', text: 'hello' });
  });

  it('skips non-message kinds and malformed payloads', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(threadItemToChatMessage({ ...base, kind: 'exec', payload: { text: 'x' } })).toBeNull();
    expect(threadItemToChatMessage({ ...base, kind: 'message', payload: { nope: 1 } })).toBeNull();
  });
});
