import { beforeEach, describe, expect, it, vi } from 'vitest';
import { wsEventSchema, type ThreadItem, type WsEvent } from '@eduagent/shared';
import type { ExerciseDto } from '@eduagent/shared';
import {
  deriveWorkbenchHydration,
  hydratedExerciseState,
  initialTurnStreamState,
  parseWsFrame,
  threadItemToChatMessage,
  turnStreamReducer,
  type ChatMessage,
  type TurnStreamState,
} from './use-turn-stream';
import {
  ARTIFACT_PAYLOAD,
  EXERCISE_PAYLOAD,
  GREETING_COMMIT,
  QUIZ_PAYLOAD,
  artifactTurnScript,
  errorTurnScript,
  exerciseFailTurnScript,
  exercisePassTurnScript,
  exerciseTurnScript,
  greetingTurnScript,
  onboardingGreetingScript,
  onboardingQuizGradedScript,
  onboardingReplyScripts,
  quizGradedTurnScript,
  quizTurnScript,
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
      onboardingQuizGradedScript,
      exerciseTurnScript,
      exerciseFailTurnScript,
      exercisePassTurnScript,
      quizTurnScript,
      quizGradedTurnScript,
      artifactTurnScript,
    ];
    for (const script of scripts) {
      for (const step of script) {
        const parsed = wsEventSchema.safeParse(step.event);
        expect(parsed.success, JSON.stringify(step.event).slice(0, 120)).toBe(true);
      }
    }
  });

  it('fixture scripts are time-ordered', () => {
    for (const script of [
      greetingTurnScript,
      replyTurnScript,
      errorTurnScript,
      onboardingQuizGradedScript,
      exerciseTurnScript,
      exerciseFailTurnScript,
      exercisePassTurnScript,
      quizTurnScript,
      quizGradedTurnScript,
      artifactTurnScript,
    ]) {
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
      { type: 'turn.error', threadId: 't1', message: 'lost connection', retryable: true },
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

  describe('workbench', () => {
    const pushed = applyEvents(initialTurnStreamState, [
      { type: 'workbench.exercise', exercise: EXERCISE_PAYLOAD },
    ]);

    it('workbench.exercise stores the payload, targets the tab, bumps pushSeq', () => {
      expect(pushed.workbench.exercise.payload).toEqual(EXERCISE_PAYLOAD);
      expect(pushed.workbench.exercise.phase).toBe('editing');
      expect(pushed.workbench.pushedTab).toBe('exercise');
      expect(pushed.workbench.pushSeq).toBe(1);
    });

    it('a re-push resets the grading lifecycle (fresh exercise)', () => {
      let state = turnStreamReducer(pushed, { type: 'exercise-submitted' });
      state = applyEvents(state, [
        { type: 'exercise.graded', exerciseId: 'ex-016', verdict: 'failed', feedback: 'nope' },
        { type: 'workbench.exercise', exercise: { ...EXERCISE_PAYLOAD, id: 'ex-017' } },
      ]);
      expect(state.workbench.exercise.payload?.id).toBe('ex-017');
      expect(state.workbench.exercise.phase).toBe('editing');
      expect(state.workbench.exercise.verdict).toBeNull();
      expect(state.workbench.exercise.attempts).toBe(0);
      expect(state.workbench.pushSeq).toBe(2);
    });

    it('submit → grading with attempt counted; graded → verdict lands', () => {
      let state = turnStreamReducer(pushed, { type: 'exercise-submitted' });
      expect(state.workbench.exercise.phase).toBe('grading');
      expect(state.workbench.exercise.attempts).toBe(1);

      state = applyEvents(state, [
        {
          type: 'exercise.graded',
          exerciseId: 'ex-016',
          verdict: 'failed',
          feedback: '2 of 3 tests failed',
        },
      ]);
      expect(state.workbench.exercise.phase).toBe('graded');
      expect(state.workbench.exercise.verdict).toBe('failed');
      expect(state.workbench.exercise.feedback).toBe('2 of 3 tests failed');
    });

    it('try again re-enables editing, keeps the attempt count', () => {
      let state = turnStreamReducer(pushed, { type: 'exercise-submitted' });
      state = applyEvents(state, [
        { type: 'exercise.graded', exerciseId: 'ex-016', verdict: 'failed', feedback: 'nope' },
      ]);
      state = turnStreamReducer(state, { type: 'exercise-try-again' });
      expect(state.workbench.exercise.phase).toBe('editing');
      expect(state.workbench.exercise.verdict).toBeNull();
      expect(state.workbench.exercise.attempts).toBe(1);

      state = turnStreamReducer(state, { type: 'exercise-submitted' });
      state = applyEvents(state, [
        { type: 'exercise.graded', exerciseId: 'ex-016', verdict: 'passed', feedback: 'all pass' },
      ]);
      expect(state.workbench.exercise.verdict).toBe('passed');
      expect(state.workbench.exercise.attempts).toBe(2);
    });

    it('a graded event for a different exercise id is ignored', () => {
      const state = applyEvents(turnStreamReducer(pushed, { type: 'exercise-submitted' }), [
        { type: 'exercise.graded', exerciseId: 'ex-999', verdict: 'passed', feedback: 'stale' },
      ]);
      expect(state.workbench.exercise.phase).toBe('grading');
      expect(state.workbench.exercise.verdict).toBeNull();
    });

    it('409 grading_in_progress keeps the grading state without an error', () => {
      // First submit is grading; an impatient second submit 409s.
      let state = turnStreamReducer(pushed, { type: 'exercise-submitted' });
      state = turnStreamReducer(state, { type: 'exercise-submitted' });
      state = turnStreamReducer(state, { type: 'exercise-grading-in-progress' });
      expect(state.workbench.exercise.phase).toBe('grading');
      expect(state.workbench.exercise.attempts).toBe(1);
      expect(state.workbench.exercise.submitError).toBeNull();
    });

    it('history hydrates empty workbench slots from mirrored payloads without auto-opening', () => {
      const hydration = {
        exercise: hydratedExerciseState(EXERCISE_PAYLOAD, null),
        quiz: QUIZ_PAYLOAD,
      };
      const state = turnStreamReducer(initialTurnStreamState, {
        type: 'history',
        items: [],
        hydration,
      });
      expect(state.workbench.exercise.payload).toEqual(EXERCISE_PAYLOAD);
      expect(state.workbench.exercise.phase).toBe('editing');
      expect(state.workbench.quiz.payload).toEqual(QUIZ_PAYLOAD);
      expect(state.workbench.pushSeq).toBe(0);
      expect(state.workbench.pushedTab).toBeNull();
    });

    it('history restores a graded exercise with its verdict (reload mid-lesson)', () => {
      const dto = exerciseDtoFor(EXERCISE_PAYLOAD, 'failed', [
        gradedAttempt('a1', 'failed', 'Off by one on the empty case.'),
      ]);
      const state = turnStreamReducer(initialTurnStreamState, {
        type: 'history',
        items: [],
        hydration: { exercise: hydratedExerciseState(EXERCISE_PAYLOAD, dto) },
      });
      expect(state.workbench.exercise.phase).toBe('graded');
      expect(state.workbench.exercise.verdict).toBe('failed');
      expect(state.workbench.exercise.feedback).toBe('Off by one on the empty case.');
      expect(state.workbench.exercise.attempts).toBe(1);
      // "Try again" still hands the editor back after a restored fail.
      const retried = turnStreamReducer(state, { type: 'exercise-try-again' });
      expect(retried.workbench.exercise.phase).toBe('editing');
      expect(retried.workbench.exercise.attempts).toBe(1);
    });

    it('hydration never clobbers a live-pushed payload', () => {
      const live = applyEvents(initialTurnStreamState, [
        { type: 'workbench.exercise', exercise: { ...EXERCISE_PAYLOAD, id: 'ex-live' } },
      ]);
      const state = turnStreamReducer(live, {
        type: 'history',
        items: [],
        hydration: { exercise: hydratedExerciseState(EXERCISE_PAYLOAD, null) },
      });
      expect(state.workbench.exercise.payload?.id).toBe('ex-live');
    });

    it('submit failure rolls back the attempt and surfaces the error', () => {
      let state = turnStreamReducer(pushed, { type: 'exercise-submitted' });
      state = turnStreamReducer(state, {
        type: 'exercise-submit-failed',
        message: 'server unreachable',
      });
      expect(state.workbench.exercise.phase).toBe('editing');
      expect(state.workbench.exercise.attempts).toBe(0);
      expect(state.workbench.exercise.submitError).toBe('server unreachable');
    });

    it('turn.error mid-grading hands the editor back instead of stranding "Grading…"', () => {
      let state = turnStreamReducer(pushed, { type: 'exercise-submitted' });
      state = applyEvents(state, [
        { type: 'turn.error', threadId: 't1', message: 'the grader crashed', retryable: true },
      ]);
      expect(state.workbench.exercise.phase).toBe('editing');
      expect(state.workbench.exercise.submitError).toBe('the grader crashed');
    });

    it('quiz push → submit → graded matches only its own quiz id', () => {
      let state = applyEvents(initialTurnStreamState, [
        { type: 'workbench.quiz', quiz: QUIZ_PAYLOAD },
      ]);
      expect(state.workbench.pushedTab).toBe('quiz');
      expect(state.workbench.quiz.phase).toBe('answering');

      state = turnStreamReducer(state, { type: 'quiz-submitted' });
      expect(state.workbench.quiz.phase).toBe('grading');

      const results = [{ question_id: 'q3', verdict: 'partial' as const, feedback_md: 'close' }];
      state = applyEvents(state, [{ type: 'quiz.graded', quizId: 'other-quiz', results }]);
      expect(state.workbench.quiz.phase).toBe('grading');

      state = applyEvents(state, [{ type: 'quiz.graded', quizId: 'quiz-007', results }]);
      expect(state.workbench.quiz.phase).toBe('graded');
      expect(state.workbench.quiz.results).toEqual(results);
    });

    it('workbench.artifact stores the payload and targets the artifact tab', () => {
      const state = applyEvents(initialTurnStreamState, [
        { type: 'workbench.artifact', artifact: ARTIFACT_PAYLOAD },
      ]);
      expect(state.workbench.artifact).toEqual(ARTIFACT_PAYLOAD);
      expect(state.workbench.pushedTab).toBe('artifact');
    });

    it('assessment.recorded replaces the strip payload and bumps its seq', () => {
      const deltas = [
        { topic: 'sql', concept: 'left-join', from: 0.55, to: 0.68, evidence: 'ex-016 passed' },
      ];
      let state = applyEvents(initialTurnStreamState, [
        { type: 'assessment.recorded', concept_deltas: deltas },
      ]);
      expect(state.workbench.assessment?.concept_deltas).toEqual(deltas);
      expect(state.workbench.assessmentSeq).toBe(1);
      state = applyEvents(state, [
        { type: 'assessment.recorded', concept_deltas: deltas, misconceptions_resolved: ['x'] },
      ]);
      expect(state.workbench.assessmentSeq).toBe(2);
      expect(state.workbench.assessment?.misconceptions_resolved).toEqual(['x']);
    });

    it('the scripted exercise loop lands the documented end state', () => {
      // push → submit → fail → try again → submit → pass + assessment
      let state = applyEvents(
        initialTurnStreamState,
        exerciseTurnScript.map((s) => s.event),
      );
      state = turnStreamReducer(state, { type: 'exercise-submitted' });
      state = applyEvents(
        state,
        exerciseFailTurnScript.map((s) => s.event),
      );
      expect(state.workbench.exercise.verdict).toBe('failed');

      state = turnStreamReducer(state, { type: 'exercise-try-again' });
      state = turnStreamReducer(state, { type: 'exercise-submitted' });
      state = applyEvents(
        state,
        exercisePassTurnScript.map((s) => s.event),
      );
      expect(state.workbench.exercise.verdict).toBe('passed');
      expect(state.workbench.exercise.attempts).toBe(2);
      expect(state.workbench.assessment?.concept_deltas).toHaveLength(2);
      expect(state.turnStatus).toBe('idle');
    });

    it('reset clears workbench state', () => {
      const state = turnStreamReducer(pushed, { type: 'reset' });
      expect(state.workbench).toEqual(initialTurnStreamState.workbench);
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

function gradedAttempt(
  id: string,
  verdict: 'passed' | 'failed' | 'error' | null,
  feedback: string | null = null,
): NonNullable<ExerciseDto['attempts']>[number] {
  return {
    id,
    code: 'def solve(): ...',
    verdict,
    feedback,
    createdAt: '2026-07-17T12:00:00Z',
    gradedAt: verdict === null ? null : '2026-07-17T12:01:00Z',
  };
}

function exerciseDtoFor(
  payload: typeof EXERCISE_PAYLOAD,
  status: ExerciseDto['status'],
  attempts: NonNullable<ExerciseDto['attempts']>,
): ExerciseDto {
  return {
    id: payload.id,
    threadId: 't1',
    language: payload.language,
    title: payload.title,
    prompt: payload.prompt_md,
    starterCode: payload.starter_code,
    concepts: payload.concepts,
    difficulty: payload.difficulty,
    status,
    createdAt: '2026-07-17T11:59:00Z',
    attempts,
  };
}

describe('hydratedExerciseState', () => {
  it('no DTO (or a mismatched id) → pristine editing state', () => {
    const pristine = hydratedExerciseState(EXERCISE_PAYLOAD, null);
    expect(pristine.phase).toBe('editing');
    expect(pristine.attempts).toBe(0);
    const mismatched = hydratedExerciseState(
      EXERCISE_PAYLOAD,
      exerciseDtoFor({ ...EXERCISE_PAYLOAD, id: 'ex-other' }, 'passed', [
        gradedAttempt('a1', 'passed'),
      ]),
    );
    expect(mismatched.phase).toBe('editing');
    expect(mismatched.attempts).toBe(0);
  });

  it('an ungraded attempt → still grading (verdict arrives over the reconnected socket)', () => {
    const state = hydratedExerciseState(
      EXERCISE_PAYLOAD,
      exerciseDtoFor(EXERCISE_PAYLOAD, 'open', [
        gradedAttempt('a1', 'failed', 'nope'),
        gradedAttempt('a2', null),
      ]),
    );
    expect(state.phase).toBe('grading');
    expect(state.attempts).toBe(2);
    expect(state.verdict).toBeNull();
  });

  it('graded exercise → verdict + feedback of the LATEST graded attempt', () => {
    const state = hydratedExerciseState(
      EXERCISE_PAYLOAD,
      exerciseDtoFor(EXERCISE_PAYLOAD, 'passed', [
        gradedAttempt('a1', 'failed', 'first try feedback'),
        gradedAttempt('a2', 'passed', 'clean solve'),
      ]),
    );
    expect(state.phase).toBe('graded');
    expect(state.verdict).toBe('passed');
    expect(state.feedback).toBe('clean solve');
    expect(state.attempts).toBe(2);
  });

  it('errored attempts alone (grading turn died) → editing with the attempt count', () => {
    const state = hydratedExerciseState(
      EXERCISE_PAYLOAD,
      exerciseDtoFor(EXERCISE_PAYLOAD, 'open', [gradedAttempt('a1', 'error')]),
    );
    expect(state.phase).toBe('editing');
    expect(state.verdict).toBeNull();
    expect(state.attempts).toBe(1);
  });
});

describe('deriveWorkbenchHydration', () => {
  const base: Omit<ThreadItem, 'kind' | 'payload' | 'id'> = {
    codexItemId: null,
    role: 'agent',
    createdAt: '2026-07-17T12:00:00Z',
  };

  it('takes the LAST valid exercise_ref/quiz payloads; artifacts are never mirrored', () => {
    const items: ThreadItem[] = [
      { ...base, id: 'i1', kind: 'exercise_ref', payload: { ...EXERCISE_PAYLOAD, id: 'ex-old' } },
      { ...base, id: 'i2', kind: 'message', payload: { text: 'chat' } },
      { ...base, id: 'i3', kind: 'quiz', payload: QUIZ_PAYLOAD },
      { ...base, id: 'i4', kind: 'exercise_ref', payload: EXERCISE_PAYLOAD },
    ];
    const hydration = deriveWorkbenchHydration(items);
    expect(hydration.exercise?.id).toBe(EXERCISE_PAYLOAD.id);
    expect(hydration.quiz?.id).toBe(QUIZ_PAYLOAD.id);
  });

  it('skips malformed payloads with a warning and returns empty when nothing matches', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items: ThreadItem[] = [
      { ...base, id: 'i1', kind: 'exercise_ref', payload: { nope: true } },
      { ...base, id: 'i2', kind: 'message', payload: { text: 'chat' } },
    ];
    expect(deriveWorkbenchHydration(items)).toEqual({});
    expect(console.warn).toHaveBeenCalled();
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

  it('system rows prefer the caption over the raw grading instructions', () => {
    const item: ThreadItem = {
      ...base,
      role: 'system',
      kind: 'message',
      payload: {
        text: 'The learner submitted ex-001…\n1. Run the hidden tests…',
        caption: 'Attempt 1 on ex-001 submitted.',
      },
    };
    expect(threadItemToChatMessage(item)).toEqual({
      id: 'i1',
      role: 'system',
      text: 'Attempt 1 on ex-001 submitted.',
    });
    // Agent rows never swap in a caption; the greeting token passes through
    // (message-bubble maps it to "Session started").
    expect(
      threadItemToChatMessage({ ...base, kind: 'message', payload: { text: 'hi', caption: 'x' } }),
    ).toEqual({ id: 'i1', role: 'agent', text: 'hi' });
    expect(
      threadItemToChatMessage({
        ...base,
        role: 'system',
        kind: 'message',
        payload: { text: '[session-start]' },
      }),
    ).toEqual({ id: 'i1', role: 'system', text: '[session-start]' });
  });

  it('caption-less system rows NEVER render their raw text (QA finding F1 — pre-caption rows)', () => {
    // Rows written by a pre-caption server carry only the full internal
    // grading instructions; the render-time guard swaps in a generic line so
    // the leak is impossible regardless of what the server wrote.
    const legacy = threadItemToChatMessage({
      ...base,
      role: 'system',
      kind: 'message',
      payload: {
        text: 'The learner submitted their solution for exercise ex-001…\n1. Run the hidden tests in `.exercises/ex-001/tests/`…\n2. Call ui_grade_exercise…',
      },
    });
    expect(legacy).toEqual({
      id: 'i1',
      role: 'system',
      text: 'The tutor ran a task in the background.',
    });
    expect(legacy!.text).not.toContain('ui_grade_exercise');
  });

  it('skips non-message kinds and malformed payloads', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(threadItemToChatMessage({ ...base, kind: 'exec', payload: { text: 'x' } })).toBeNull();
    expect(threadItemToChatMessage({ ...base, kind: 'message', payload: { nope: 1 } })).toBeNull();
  });
});
