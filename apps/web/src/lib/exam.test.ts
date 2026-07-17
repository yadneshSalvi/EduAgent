import { describe, expect, it } from 'vitest';
import type { ExamQuestions, ExamResult, ThreadSummary, TimelineEntry } from '@eduagent/shared';
import type { KeyValueStore } from './workbench';
import {
  autosaveDue,
  findExamCommitIndex,
  buildConceptResults,
  buildPalette,
  buildQuestionResults,
  clearExamLocal,
  conceptOutcome,
  examDeadlineMs,
  flattenQuestions,
  formatClock,
  isAnswered,
  loadExamAnswers,
  loadExamFlags,
  mergeAnswers,
  msRemaining,
  pollIntervalMs,
  readinessSweep,
  resolveExamThreadId,
  saveExamAnswersLocal,
  saveExamFlags,
  timerTone,
  totalPoints,
  unansweredCount,
} from './exam';

const QUESTIONS: ExamQuestions = {
  track: 'cs-interviews',
  duration_min: 30,
  sections: [
    {
      title: 'Warmup',
      questions: [
        {
          id: 'q1',
          type: 'mcq',
          prompt_md: 'Pick one.',
          concepts: ['big-o'],
          options: ['O(1)', 'O(n)'],
          points: 2,
        },
        {
          id: 'q2',
          type: 'short',
          prompt_md: 'Explain.',
          concepts: ['big-o', 'hash-maps'],
          points: 3,
        },
      ],
    },
    {
      title: 'Coding',
      questions: [
        {
          id: 'q3',
          type: 'coding',
          prompt_md: 'Write it.',
          concepts: ['two-pointers'],
          language: 'python',
          starter_code: 'def solve():\n    pass\n',
          points: 5,
        },
      ],
    },
  ],
};

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe('deadline math', () => {
  const startedAt = '2026-07-17T10:00:00.000Z';

  it('deadline = startedAt + durationMin, no grace baked in', () => {
    expect(examDeadlineMs(startedAt, 30)).toBe(new Date('2026-07-17T10:30:00.000Z').getTime());
  });

  it('remaining clamps at zero past the deadline', () => {
    const deadline = examDeadlineMs(startedAt, 30);
    expect(msRemaining(deadline, deadline - 1500)).toBe(1500);
    expect(msRemaining(deadline, deadline + 60_000)).toBe(0);
  });

  it('formats mm:ss under an hour and h:mm:ss above', () => {
    expect(formatClock(42 * 60_000 + 17_000)).toBe('42:17');
    expect(formatClock(62 * 60_000 + 7_000)).toBe('1:02:07');
    expect(formatClock(0)).toBe('0:00');
    // 900ms ceils to a full second — the clock never shows 0:00 early.
    expect(formatClock(900)).toBe('0:01');
  });

  it('tone: calm → amber under 5min → red under 1min', () => {
    expect(timerTone(301_000)).toBe('calm');
    expect(timerTone(299_000)).toBe('amber');
    expect(timerTone(60_000)).toBe('amber');
    expect(timerTone(59_999)).toBe('red');
  });
});

describe('question flattening & palette', () => {
  it('numbers continuously across sections', () => {
    const flat = flattenQuestions(QUESTIONS);
    expect(flat.map((f) => [f.number, f.question.id, f.sectionTitle])).toEqual([
      [1, 'q1', 'Warmup'],
      [2, 'q2', 'Warmup'],
      [3, 'q3', 'Coding'],
    ]);
    expect(totalPoints(QUESTIONS)).toBe(10);
  });

  it('answered = non-blank after trim; unanswered counts the rest', () => {
    const answers = { q1: 'O(n)', q2: '   ', q3: '' };
    expect(isAnswered(answers, 'q1')).toBe(true);
    expect(isAnswered(answers, 'q2')).toBe(false);
    expect(unansweredCount(flattenQuestions(QUESTIONS), answers)).toBe(2);
  });

  it('palette derives answered + flagged per question', () => {
    const palette = buildPalette(flattenQuestions(QUESTIONS), { q1: 'O(n)' }, new Set(['q3']));
    expect(palette).toEqual([
      { id: 'q1', number: 1, answered: true, flagged: false },
      { id: 'q2', number: 2, answered: false, flagged: false },
      { id: 'q3', number: 3, answered: false, flagged: true },
    ]);
  });
});

describe('autosave scheduling', () => {
  it('never saves while clean', () => {
    expect(autosaveDue({ dirtySince: null, lastSaveAt: 0 }, 99_999)).toBe(false);
  });

  it('debounce fires after quiet typing', () => {
    const clock = { dirtySince: 10_000, lastSaveAt: 9_000 };
    expect(autosaveDue(clock, 11_000)).toBe(false);
    expect(autosaveDue(clock, 12_500)).toBe(true);
  });

  it('heartbeat fires under continuous typing (dirtySince keeps resetting)', () => {
    // Simulates a keystroke 1s ago but the last successful save 15s ago.
    expect(autosaveDue({ dirtySince: 24_000, lastSaveAt: 10_000 }, 25_000)).toBe(true);
  });
});

describe('local persistence', () => {
  it('answers round-trip and merge with server (local wins per key)', () => {
    const store = memoryStore();
    saveExamAnswersLocal('e1', { q1: 'local', q2: 'kept' }, store);
    expect(loadExamAnswers('e1', store)).toEqual({ q1: 'local', q2: 'kept' });
    expect(mergeAnswers({ q1: 'server', q3: 'server-only' }, loadExamAnswers('e1', store))).toEqual(
      { q1: 'local', q2: 'kept', q3: 'server-only' },
    );
  });

  it('flags round-trip; clear removes both keys', () => {
    const store = memoryStore();
    saveExamFlags('e1', new Set(['q2']), store);
    expect(loadExamFlags('e1', store)).toEqual(['q2']);
    clearExamLocal('e1', store);
    expect(loadExamFlags('e1', store)).toEqual([]);
    expect(loadExamAnswers('e1', store)).toBeNull();
  });

  it('corrupt payloads read as empty, never throw', () => {
    const store = memoryStore();
    store.setItem('eduagent:exam-answers:e1', '{not json');
    store.setItem('eduagent:exam-flags:e1', '"nope"');
    expect(loadExamAnswers('e1', store)).toBeNull();
    expect(loadExamFlags('e1', store)).toEqual([]);
  });
});

describe('resolveExamThreadId', () => {
  const thread = (over: Partial<ThreadSummary>): ThreadSummary => ({
    id: 't-x',
    mode: 'exam',
    topicSlug: null,
    trackSlug: 'cs-interviews',
    title: 'Mock exam — cs-interviews',
    status: 'active',
    forkedFromId: 't-parent',
    createdAt: '2026-07-17T10:00:00.000Z',
    lastActiveAt: '2026-07-17T10:00:00.000Z',
    ...over,
  });
  const exam = { trackSlug: 'cs-interviews', createdAt: '2026-07-17T10:00:01.000Z' };

  it('picks the exam-mode thread created closest to the exam row', () => {
    const threads = [
      thread({ id: 't-new', createdAt: '2026-07-17T10:00:00.500Z' }),
      thread({ id: 't-old', createdAt: '2026-07-17T09:30:00.000Z' }),
    ];
    expect(resolveExamThreadId(threads, exam)).toBe('t-new');
  });

  it('ignores other tracks, other modes, and far-away threads', () => {
    const threads = [
      thread({ id: 't-track', trackSlug: 'sql' }),
      thread({ id: 't-mode', mode: 'learn' }),
      thread({ id: 't-far', createdAt: '2026-07-17T08:00:00.000Z' }),
    ];
    expect(resolveExamThreadId(threads, exam)).toBeNull();
  });
});

describe('results mapping', () => {
  const result: ExamResult = {
    per_question: [
      { id: 'q1', verdict: 'correct', points_awarded: 2, feedback_md: 'Right.' },
      { id: 'q2', verdict: 'partial', points_awarded: 1, feedback_md: 'Half.' },
      { id: 'q3', verdict: 'incorrect', points_awarded: 0, feedback_md: 'Off-by-one.' },
    ],
    total: 3,
    readiness_delta: -1.2,
    readiness_before: 62.4,
    readiness_after: 61.2,
  };

  it('joins grades and answers to flattened questions', () => {
    const views = buildQuestionResults(QUESTIONS, result, { q1: 'O(n)' });
    expect(views).toHaveLength(3);
    expect(views[0]?.grade?.verdict).toBe('correct');
    expect(views[0]?.answer).toBe('O(n)');
    expect(views[2]?.grade?.feedback_md).toBe('Off-by-one.');
    expect(views[2]?.answer).toBe('');
  });

  it('tolerates a grade the questions do not know (grade: null)', () => {
    const partial: ExamResult = { ...result, per_question: [result.per_question[0]!] };
    const views = buildQuestionResults(QUESTIONS, partial, null);
    expect(views[1]?.grade).toBeNull();
  });

  it('aggregates per-concept points and verdict counts', () => {
    const concepts = buildConceptResults(buildQuestionResults(QUESTIONS, result, null));
    expect(concepts).toEqual([
      { concept: 'big-o', points: 5, pointsAwarded: 3, correct: 1, partial: 1, incorrect: 0 },
      { concept: 'hash-maps', points: 3, pointsAwarded: 1, correct: 0, partial: 1, incorrect: 0 },
      { concept: 'two-pointers', points: 5, pointsAwarded: 0, correct: 0, partial: 0, incorrect: 1 },
    ]);
    expect(conceptOutcome(concepts[0]!)).toBe('mixed');
    expect(conceptOutcome(concepts[2]!)).toBe('slipped');
    expect(
      conceptOutcome({ concept: 'x', points: 2, pointsAwarded: 2, correct: 1, partial: 0, incorrect: 0 }),
    ).toBe('held');
  });

  it('readiness sweep prefers the exact snapshot and recomputes the delta', () => {
    expect(readinessSweep(result)).toEqual({ before: 62.4, after: 61.2, delta: -1.2 });
  });

  it('derives the missing side from the delta, clamped to 0..100', () => {
    expect(readinessSweep({ ...result, readiness_after: undefined })).toEqual({
      before: 62.4,
      after: 61.2,
      delta: -1.2,
    });
    expect(
      readinessSweep({
        per_question: result.per_question,
        total: 3,
        readiness_delta: 5,
        readiness_before: 98,
      }),
    ).toEqual({ before: 98, after: 100, delta: 5 });
  });

  it('falls back to delta-only when no snapshot exists', () => {
    expect(
      readinessSweep({ per_question: result.per_question, total: 3, readiness_delta: 2.5 }),
    ).toEqual({ before: null, after: null, delta: 2.5 });
  });
});

describe('pollIntervalMs', () => {
  const startedAt = '2026-07-17T10:00:00.000Z';
  const started = new Date(startedAt).getTime();

  it('polls fast while generating or grading', () => {
    expect(pollIntervalMs({ status: 'draft', startedAt: null, durationMin: 30 }, started)).toBe(2500);
    expect(pollIntervalMs({ status: 'submitted', startedAt, durationMin: 30 }, started)).toBe(2500);
  });

  it('polls an expired in_progress exam (sweep observation), not a live one', () => {
    const exam = { status: 'in_progress' as const, startedAt, durationMin: 30 };
    expect(pollIntervalMs(exam, started + 29 * 60_000)).toBe(false);
    expect(pollIntervalMs(exam, started + 30 * 60_000)).toBe(3000);
  });

  it('is off for ready, graded, and unknown exams', () => {
    expect(pollIntervalMs(undefined, started)).toBe(false);
    expect(pollIntervalMs({ status: 'ready', startedAt: null, durationMin: 30 }, started)).toBe(false);
    expect(pollIntervalMs({ status: 'graded', startedAt, durationMin: 30 }, started)).toBe(false);
  });
});

describe('findExamCommitIndex', () => {
  const entry = (over: Partial<TimelineEntry>): TimelineEntry => ({
    sha: 'abc123',
    type: 'learn',
    topic: 'general',
    headline: 'x',
    bullets: [],
    deltas: [],
    date: '2026-07-17T12:00:00.000Z',
    ...over,
  });

  it('finds the newest exam commit at/after submission (with slack)', () => {
    const commits = [
      entry({ sha: 'later-learn', type: 'learn', date: '2026-07-17T12:10:00.000Z' }),
      entry({ sha: 'exam-commit', type: 'exam', date: '2026-07-17T12:05:00.000Z' }),
      entry({ sha: 'old-exam', type: 'exam', date: '2026-07-16T09:00:00.000Z' }),
    ];
    expect(findExamCommitIndex(commits, '2026-07-17T12:05:30.000Z')).toBe(1);
    expect(findExamCommitIndex(commits, null)).toBe(1);
  });

  it('returns -1 when the grading commit has not landed', () => {
    const commits = [entry({ type: 'exam', date: '2026-07-16T09:00:00.000Z' })];
    expect(findExamCommitIndex(commits, '2026-07-17T12:00:00.000Z')).toBe(-1);
  });
});
