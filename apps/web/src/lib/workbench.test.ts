import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '@eduagent/shared';
import {
  buildQuizSubmission,
  checkAnswer,
  exerciseCodeKey,
  loadExerciseCode,
  loadWorkbenchOpen,
  monacoLanguage,
  normalizePredictedOutput,
  saveExerciseCode,
  saveWorkbenchOpen,
  type KeyValueStore,
} from './workbench';

/** In-memory KeyValueStore — the tests never need a DOM. */
function fakeStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const MCQ: QuizQuestion = {
  id: 'q1',
  type: 'mcq',
  prompt_md: 'Which join?',
  options: ['LEFT JOIN', 'INNER JOIN'],
  answer: 'INNER JOIN',
};

const PREDICT: QuizQuestion = {
  id: 'q2',
  type: 'predict_output',
  prompt_md: 'What does it return?',
  answer: '5 rows',
};

const SHORT: QuizQuestion = {
  id: 'q3',
  type: 'short',
  prompt_md: 'Explain why.',
};

describe('checkAnswer', () => {
  it('mcq: exact option match (whitespace-trimmed)', () => {
    expect(checkAnswer(MCQ, 'INNER JOIN')).toBe('correct');
    expect(checkAnswer(MCQ, '  INNER JOIN ')).toBe('correct');
    expect(checkAnswer(MCQ, 'LEFT JOIN')).toBe('incorrect');
  });

  it('predict_output: whitespace-collapsed, case-insensitive match', () => {
    expect(checkAnswer(PREDICT, '5 rows')).toBe('correct');
    expect(checkAnswer(PREDICT, '  5   ROWS  ')).toBe('correct');
    expect(checkAnswer(PREDICT, '5\nrows')).toBe('incorrect');
    expect(checkAnswer(PREDICT, '6 rows')).toBe('incorrect');
  });

  it('short answers (and questions missing a key) are agent-graded → null', () => {
    expect(checkAnswer(SHORT, 'because NULLs')).toBeNull();
    expect(checkAnswer({ ...MCQ, answer: undefined }, 'INNER JOIN')).toBeNull();
  });
});

describe('normalizePredictedOutput', () => {
  it('normalizes line endings, per-line whitespace, and outer blank lines', () => {
    expect(normalizePredictedOutput('  a   b \r\n\r\n c ')).toBe('a b\n\nc');
    expect(normalizePredictedOutput('\n\nx\n\n')).toBe('x');
  });

  it('keeps line structure significant', () => {
    expect(normalizePredictedOutput('5\n6')).not.toBe(normalizePredictedOutput('56'));
  });
});

describe('buildQuizSubmission', () => {
  it('ships every answer; verdicts only for client-checked questions', () => {
    const submission = buildQuizSubmission([MCQ, PREDICT, SHORT], {
      q1: 'INNER JOIN',
      q2: '6 rows',
      q3: 'the ON clause decides matching',
    });
    expect(submission).toEqual([
      { question_id: 'q1', answer: 'INNER JOIN', verdict: 'correct' },
      { question_id: 'q2', answer: '6 rows', verdict: 'incorrect' },
      { question_id: 'q3', answer: 'the ON clause decides matching' },
    ]);
  });

  it('unanswered questions ship as empty strings', () => {
    expect(buildQuizSubmission([SHORT], {})).toEqual([{ question_id: 'q3', answer: '' }]);
  });
});

describe('exercise code persistence', () => {
  it('round-trips code per exercise id', () => {
    const store = fakeStore();
    saveExerciseCode('ex-016', 'SELECT 1;', store);
    expect(loadExerciseCode('ex-016', store)).toBe('SELECT 1;');
    expect(loadExerciseCode('ex-017', store)).toBeNull();
    expect(store.data.has(exerciseCodeKey('ex-016'))).toBe(true);
  });

  it('is null-safe without a store (SSR / private mode)', () => {
    expect(loadExerciseCode('ex-016', null)).toBeNull();
    expect(() => saveExerciseCode('ex-016', 'x', null)).not.toThrow();
  });

  it('swallows storage write failures (quota)', () => {
    const store: KeyValueStore = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(() => saveExerciseCode('ex-016', 'x', store)).not.toThrow();
  });
});

describe('workbench open persistence', () => {
  it('round-trips per thread; junk reads as no-preference', () => {
    const store = fakeStore();
    expect(loadWorkbenchOpen('t1', store)).toBeNull();
    saveWorkbenchOpen('t1', true, store);
    expect(loadWorkbenchOpen('t1', store)).toBe(true);
    saveWorkbenchOpen('t1', false, store);
    expect(loadWorkbenchOpen('t1', store)).toBe(false);
    store.setItem('eduagent:workbench-open:t2', 'garbage');
    expect(loadWorkbenchOpen('t2', store)).toBeNull();
  });
});

describe('monacoLanguage', () => {
  it('maps common aliases and lowercases the rest', () => {
    expect(monacoLanguage('SQL')).toBe('sql');
    expect(monacoLanguage('py')).toBe('python');
    expect(monacoLanguage('ts')).toBe('typescript');
    expect(monacoLanguage('rust')).toBe('rust');
  });
});
