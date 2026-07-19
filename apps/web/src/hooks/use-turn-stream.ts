'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';
import { z } from 'zod';
import {
  exercisePayloadSchema,
  quizPayloadSchema,
  sessionWrapPayloadSchema,
  wsEventSchema,
  type ArtifactPayload,
  type AssessmentPayload,
  type ClientWsEvent,
  type ExerciseDto,
  type ExercisePayload,
  type ExerciseVerdict,
  type MemoryCommit,
  type QuizGradeResult,
  type QuizPayload,
  type ThreadItem,
  type WsEvent,
} from '@eduagent/shared';
import { ApiError, getExercise, getThreadItems, threadSocketUrl } from '@/lib/api';

/**
 * Turn state per thread (plans/04 §2): one hook owns the WS connection to
 * `GET /ws?threadId=` and reduces the WsEvent stream into renderable state.
 * Every inbound frame is parsed with the shared `wsEventSchema` — invalid
 * frames are console.warn'd and ignored, never rendered.
 */

interface StandardChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  text: string;
  kind?: 'message';
  /** Optimistic local send, not yet mirrored by the server. */
  pending?: boolean;
}

export interface ReasoningChatMessage {
  id: string;
  role: 'agent';
  kind: 'reasoning';
  text: string;
  pending?: never;
}

export interface SessionWrapChatMessage {
  id: string;
  role: 'agent';
  kind: 'wrap';
  text: string;
  wrap: z.infer<typeof sessionWrapPayloadSchema>;
  pending?: never;
}

export type ChatMessage = StandardChatMessage | ReasoningChatMessage | SessionWrapChatMessage;

export interface ActivityChip {
  id: string;
  kind: 'exec' | 'tool';
  label: string;
  status: 'started' | 'completed' | 'failed';
}

export type TurnStatus = 'idle' | 'awaiting' | 'streaming';

export type WorkbenchTab = 'exercise' | 'quiz' | 'artifact';

export interface WorkbenchExerciseState {
  payload: ExercisePayload | null;
  /** editing → grading (submit in flight / grading turn running) → graded. */
  phase: 'editing' | 'grading' | 'graded';
  verdict: ExerciseVerdict | null;
  feedback: string;
  /** Submissions accepted so far (optimistic; rolled back on submit failure). */
  attempts: number;
  /** The POST itself failed — grading never started. */
  submitError: string | null;
}

export interface WorkbenchQuizState {
  payload: QuizPayload | null;
  phase: 'answering' | 'grading' | 'graded';
  results: QuizGradeResult[] | null;
  submitError: string | null;
}

export interface WorkbenchState {
  exercise: WorkbenchExerciseState;
  quiz: WorkbenchQuizState;
  artifact: ArtifactPayload | null;
  /** Last workbench.* push; seq bumps each time so the panel can auto-open. */
  pushedTab: WorkbenchTab | null;
  pushSeq: number;
  /** Latest assessment.recorded payload; seq re-triggers the ticker strip. */
  assessment: AssessmentPayload | null;
  assessmentSeq: number;
}

const initialExerciseState: WorkbenchExerciseState = {
  payload: null,
  phase: 'editing',
  verdict: null,
  feedback: '',
  attempts: 0,
  submitError: null,
};

const initialQuizState: WorkbenchQuizState = {
  payload: null,
  phase: 'answering',
  results: null,
  submitError: null,
};

export const initialWorkbenchState: WorkbenchState = {
  exercise: initialExerciseState,
  quiz: initialQuizState,
  artifact: null,
  pushedTab: null,
  pushSeq: 0,
  assessment: null,
  assessmentSeq: 0,
};
export type ConnectionStatus =
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'unauthenticated'
  /** The thread doesn't exist or isn't yours (WS 4403 / items 404) — terminal. */
  | 'not-found'
  /** Reconnect attempts exhausted — terminal until the user retries. */
  | 'failed';
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
  workbench: WorkbenchState;
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
  workbench: initialWorkbenchState,
  error: null,
};

/**
 * Client-originated workbench transitions (submission lifecycle) — the only
 * actions components dispatch directly, via TurnStream.dispatch. Everything
 * else in workbench state is WS-event-derived.
 */
export type WorkbenchClientAction =
  | { type: 'exercise-submitted' }
  | { type: 'exercise-submit-failed'; message: string }
  /**
   * Submit hit 409 `grading_in_progress` (an earlier attempt is still being
   * graded, `03` §3) — stay in the grading state, never an error.
   */
  | { type: 'exercise-grading-in-progress' }
  /** Fail verdict → "Try again" re-enables the editor (attempts retained). */
  | { type: 'exercise-try-again' }
  | { type: 'quiz-submitted' }
  | { type: 'quiz-submit-failed'; message: string };

export type TurnStreamAction =
  | { type: 'event'; event: WsEvent }
  | { type: 'send'; item: ChatMessage }
  | { type: 'history'; items: ChatMessage[]; hydration?: WorkbenchHydration }
  | { type: 'history-loading' }
  | { type: 'history-error'; message: string }
  | { type: 'connection'; status: ConnectionStatus }
  /** Clear turn/chat state but keep the connection surface (dev-harness replay). */
  | { type: 'reset' }
  | WorkbenchClientAction;

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
  const serverWraps = new Set(
    server
      .filter((item): item is SessionWrapChatMessage => item.kind === 'wrap')
      .map((item) => `${item.wrap.day}:${item.wrap.summary_md}`),
  );
  const extras = existing.filter((item) => {
    if (serverIds.has(item.id)) return false;
    if (item.pending && serverUserTexts.has(item.text)) return false;
    if (item.kind === 'wrap' && serverWraps.has(`${item.wrap.day}:${item.wrap.summary_md}`)) {
      return false;
    }
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

/**
 * Workbench slice of the WS stream (plans/04 §3). Pushes replace the tab's
 * content and reset its grading lifecycle; graded events settle only the
 * matching id (a stale grading turn must not flip a newer exercise/quiz).
 */
function applyWorkbenchEvent(workbench: WorkbenchState, event: WsEvent): WorkbenchState {
  switch (event.type) {
    case 'workbench.exercise':
      return {
        ...workbench,
        exercise: { ...initialExerciseState, payload: event.exercise },
        pushedTab: 'exercise',
        pushSeq: workbench.pushSeq + 1,
      };

    case 'workbench.quiz':
      return {
        ...workbench,
        quiz: { ...initialQuizState, payload: event.quiz },
        pushedTab: 'quiz',
        pushSeq: workbench.pushSeq + 1,
      };

    case 'workbench.artifact':
      return {
        ...workbench,
        artifact: event.artifact,
        pushedTab: 'artifact',
        pushSeq: workbench.pushSeq + 1,
      };

    case 'exercise.graded': {
      if (workbench.exercise.payload?.id !== event.exerciseId) return workbench;
      return {
        ...workbench,
        exercise: {
          ...workbench.exercise,
          phase: 'graded',
          verdict: event.verdict,
          feedback: event.feedback,
          submitError: null,
        },
      };
    }

    case 'quiz.graded': {
      if (workbench.quiz.payload?.id !== event.quizId) return workbench;
      return {
        ...workbench,
        quiz: { ...workbench.quiz, phase: 'graded', results: event.results, submitError: null },
      };
    }

    case 'assessment.recorded':
      return {
        ...workbench,
        assessment: {
          concept_deltas: event.concept_deltas,
          ...(event.misconceptions_opened
            ? { misconceptions_opened: event.misconceptions_opened }
            : {}),
          ...(event.misconceptions_resolved
            ? { misconceptions_resolved: event.misconceptions_resolved }
            : {}),
        },
        assessmentSeq: workbench.assessmentSeq + 1,
      };

    case 'turn.error': {
      // A grading turn that dies must not strand the workbench in "Grading…" —
      // hand control back so the learner can submit again.
      let next = workbench;
      if (next.exercise.phase === 'grading') {
        next = {
          ...next,
          exercise: { ...next.exercise, phase: 'editing', submitError: event.message },
        };
      }
      if (next.quiz.phase === 'grading') {
        next = { ...next, quiz: { ...next.quiz, phase: 'answering', submitError: event.message } };
      }
      return next;
    }

    default:
      return workbench;
  }
}

function applyEvent(state: TurnStreamState, event: WsEvent): TurnStreamState {
  const workbench = applyWorkbenchEvent(state.workbench, event);
  if (workbench !== state.workbench) state = { ...state, workbench };
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

    case 'session.wrap': {
      const item: SessionWrapChatMessage = {
        id: `wrap-${event.threadId}-${event.wrap.day}-${state.items.length}`,
        role: 'agent',
        kind: 'wrap',
        text: event.wrap.summary_md,
        wrap: event.wrap,
      };
      return { ...state, items: upsertItem(state.items, item), turnStatus: 'awaiting' };
    }

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

    // Workbench / grading / assessment events were folded in by
    // applyWorkbenchEvent above; exam events are Phase 3/4 surfaces.
    case 'workbench.exercise':
    case 'workbench.quiz':
    case 'workbench.artifact':
    case 'assessment.recorded':
    case 'exercise.graded':
    case 'quiz.graded':
    case 'exam.created':
    case 'exam.graded':
    // Track events get their real handlers in the tracks frontend slice.
    case 'track.updated':
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
    case 'history': {
      // Mirror-backed workbench hydration (task #15 contract): fills EMPTY
      // slots only — live WS pushes always outrank the mirror — and never
      // bumps pushSeq, so a reload restores content without auto-opening.
      let workbench = state.workbench;
      if (action.hydration?.exercise && !workbench.exercise.payload) {
        workbench = { ...workbench, exercise: action.hydration.exercise };
      }
      if (action.hydration?.quiz && !workbench.quiz.payload) {
        workbench = {
          ...workbench,
          quiz: { ...initialQuizState, payload: action.hydration.quiz },
        };
      }
      return {
        ...state,
        items: mergeHistory(state.items, action.items),
        history: 'ready',
        historyError: null,
        workbench,
      };
    }
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

    case 'exercise-submitted':
      return {
        ...state,
        workbench: {
          ...state.workbench,
          exercise: {
            ...state.workbench.exercise,
            phase: 'grading',
            verdict: null,
            feedback: '',
            attempts: state.workbench.exercise.attempts + 1,
            submitError: null,
          },
        },
      };
    case 'exercise-submit-failed':
      // The POST never reached the grader — roll back the optimistic attempt.
      return {
        ...state,
        workbench: {
          ...state.workbench,
          exercise: {
            ...state.workbench.exercise,
            phase: 'editing',
            attempts: Math.max(0, state.workbench.exercise.attempts - 1),
            submitError: action.message,
          },
        },
      };
    case 'exercise-grading-in-progress':
      // A prior attempt is still grading (409): this submit didn't count, but
      // the panel stays in "Grading…" — the verdict is on its way over WS.
      return {
        ...state,
        workbench: {
          ...state.workbench,
          exercise: {
            ...state.workbench.exercise,
            phase: 'grading',
            attempts: Math.max(1, state.workbench.exercise.attempts - 1),
            submitError: null,
          },
        },
      };
    case 'exercise-try-again':
      return {
        ...state,
        workbench: {
          ...state.workbench,
          exercise: {
            ...state.workbench.exercise,
            phase: 'editing',
            verdict: null,
            feedback: '',
            submitError: null,
          },
        },
      };
    case 'quiz-submitted':
      return {
        ...state,
        workbench: {
          ...state.workbench,
          quiz: { ...state.workbench.quiz, phase: 'grading', submitError: null },
        },
      };
    case 'quiz-submit-failed':
      return {
        ...state,
        workbench: {
          ...state.workbench,
          quiz: { ...state.workbench.quiz, phase: 'answering', submitError: action.message },
        },
      };
  }
}

/**
 * ItemMirror payload for `kind: "message"` rows (task #11 contract): `{text}`.
 * System rows (grading turns) also carry `caption` — the short human line the
 * chat shows instead of the full internal instruction text.
 */
const messagePayloadSchema = z.object({ text: z.string(), caption: z.string().optional() });
const reasoningPayloadSchema = z.object({ summary: z.array(z.string()) });

/** The auto-greeting trigger row (ThreadManager.GREETING_INPUT) — the one
 * caption-less system row that is safe to pass through (message-bubble maps
 * it to "Session started"). */
const GREETING_INPUT = '[session-start]';

/** Render-time fallback for caption-less system rows: their `text` is a raw
 * server instruction (e.g. a pre-caption grading turn — QA finding F1) and
 * must NEVER reach the chat, no matter what the server wrote. */
const SYSTEM_FALLBACK_CAPTION = 'The tutor ran a task in the background.';

export function threadItemToChatMessage(item: ThreadItem): ChatMessage | null {
  if (item.kind === 'reasoning') {
    const parsed = reasoningPayloadSchema.safeParse(item.payload);
    if (!parsed.success) {
      console.warn('reasoning item payload missing {summary}, skipping', item.id);
      return null;
    }
    return {
      id: item.id,
      role: 'agent',
      kind: 'reasoning',
      text: parsed.data.summary.join('\n\n'),
    };
  }
  if (item.kind === 'wrap') {
    const parsed = sessionWrapPayloadSchema.safeParse(item.payload);
    if (!parsed.success) {
      console.warn('wrap item payload failed sessionWrapPayloadSchema, skipping', item.id);
      return null;
    }
    return {
      id: item.id,
      role: 'agent',
      kind: 'wrap',
      text: parsed.data.summary_md,
      wrap: parsed.data,
    };
  }
  if (item.kind !== 'message') return null;
  const parsed = messagePayloadSchema.safeParse(item.payload);
  if (!parsed.success) {
    console.warn('thread item payload missing {text}, skipping', item.id);
    return null;
  }
  let text = parsed.data.text;
  if (item.role === 'system' && text !== GREETING_INPUT) {
    text = parsed.data.caption ?? SYSTEM_FALLBACK_CAPTION;
  }
  return { id: item.id, role: item.role, text };
}

/**
 * What the `history` action restores into empty workbench slots. The exercise
 * side is a full slice state (payload + grading lifecycle from the exercise
 * DTO); the quiz side is payload-only — quiz verdicts aren't queryable, so a
 * reloaded quiz starts back at `answering` (retaking is harmless in learn
 * mode; the mastery evidence already reached the agent).
 */
export interface WorkbenchHydration {
  exercise?: WorkbenchExerciseState;
  quiz?: QuizPayload;
}

/** The latest mirrored payloads of each kind, before DTO enrichment. */
export interface WorkbenchMirrorPayloads {
  exercise?: ExercisePayload;
  quiz?: QuizPayload;
}

/**
 * Rebuilds workbench content from mirrored history (task #15 contract):
 * `exercise_ref` and `quiz` ItemMirror rows carry the full client-safe
 * payloads; artifacts are WS-only and vanish on reload by design. The last
 * payload of each kind wins; malformed payloads are warned and skipped.
 */
export function deriveWorkbenchHydration(items: ThreadItem[]): WorkbenchMirrorPayloads {
  const hydration: WorkbenchMirrorPayloads = {};
  for (const item of items) {
    if (item.kind === 'exercise_ref') {
      const parsed = exercisePayloadSchema.safeParse(item.payload);
      if (parsed.success) hydration.exercise = parsed.data;
      else console.warn('exercise_ref payload failed exercisePayloadSchema, skipping', item.id);
    } else if (item.kind === 'quiz') {
      const parsed = quizPayloadSchema.safeParse(item.payload);
      if (parsed.success) hydration.quiz = parsed.data;
      else console.warn('quiz item payload failed quizPayloadSchema, skipping', item.id);
    }
  }
  return hydration;
}

/**
 * Restored exercise slice for a mirrored payload, enriched with the grading
 * lifecycle from `GET /api/exercises/:id` so a reload lands where the learner
 * left off: an ungraded attempt → still "grading" (the verdict arrives over
 * the reconnected socket), a graded exercise → verdict + feedback restored,
 * otherwise → editing. Without a DTO (fetch failed) the payload alone renders.
 */
export function hydratedExerciseState(
  payload: ExercisePayload,
  dto: ExerciseDto | null,
): WorkbenchExerciseState {
  const base: WorkbenchExerciseState = { ...initialExerciseState, payload };
  if (!dto || dto.id !== payload.id) return base;
  const attempts = dto.attempts ?? [];
  const withAttempts = { ...base, attempts: attempts.length };
  if (attempts.some((attempt) => attempt.verdict === null)) {
    return { ...withAttempts, phase: 'grading' };
  }
  const lastGraded = [...attempts]
    .reverse()
    .find((attempt) => attempt.verdict === 'passed' || attempt.verdict === 'failed');
  if (lastGraded && (dto.status === 'passed' || dto.status === 'failed')) {
    return {
      ...withAttempts,
      phase: 'graded',
      verdict: lastGraded.verdict as ExerciseVerdict,
      feedback: lastGraded.feedback ?? '',
    };
  }
  return withAttempts;
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
/** After this many consecutive failed connects, stop and show the error state (QA finding p9b). */
const MAX_RECONNECT_ATTEMPTS = 6;

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
  /** Workbench submission lifecycle (the only client-driven reducer channel). */
  dispatch: (action: WorkbenchClientAction) => void;
}

export function useTurnStream(threadId: string, options?: UseTurnStreamOptions): TurnStream {
  const [state, dispatch] = useReducer(turnStreamReducer, initialTurnStreamState);
  const wsRef = useRef<WebSocket | null>(null);
  const onCommitRef = useRef(options?.onCommit);
  onCommitRef.current = options?.onCommit;

  const fetchHistory = useCallback(() => {
    dispatch({ type: 'history-loading' });
    getThreadItems(threadId)
      .then(async ({ items }) => {
        const messages = items
          .map(threadItemToChatMessage)
          .filter((item): item is ChatMessage => item !== null);
        const mirror = deriveWorkbenchHydration(items);
        const hydration: WorkbenchHydration = {};
        if (mirror.quiz) hydration.quiz = mirror.quiz;
        if (mirror.exercise) {
          let dto: ExerciseDto | null = null;
          try {
            dto = await getExercise(mirror.exercise.id);
          } catch {
            // Verdict enrichment is best-effort — the payload alone still renders.
          }
          hydration.exercise = hydratedExerciseState(mirror.exercise, dto);
        }
        dispatch({ type: 'history', items: messages, hydration });
      })
      .catch((err: unknown) => {
        // A real-shaped id for a thread that isn't yours: terminal not-found,
        // never a retry loop (QA finding p9b).
        if (err instanceof ApiError && err.status === 404) {
          dispatch({ type: 'connection', status: 'not-found' });
          return;
        }
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
        if (closeEvent.code === 4403 || closeEvent.code === 4400) {
          // Not your thread / bad request — terminal, never a reconnect loop
          // (QA finding p9b: foreign-but-real-shaped ids spun forever).
          dispatch({ type: 'connection', status: 'not-found' });
          return;
        }
        attempt++;
        if (attempt > MAX_RECONNECT_ATTEMPTS) {
          dispatch({ type: 'connection', status: 'failed' });
          return;
        }
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

  const dispatchClient = useCallback((action: WorkbenchClientAction) => dispatch(action), []);

  return { state, send, refetchHistory: fetchHistory, dispatch: dispatchClient };
}
