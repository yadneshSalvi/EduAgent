import { describe, expect, it } from 'vitest';
import {
  uiCreateExamArgsSchema,
  uiPushExerciseArgsSchema,
  uiPushQuizArgsSchema,
  uiRecordAssessmentArgsSchema,
  uiToolArgSchemas,
} from '../src/index';

describe('ui tool arg schemas', () => {
  it('exposes all eight tools by wire name', () => {
    expect(Object.keys(uiToolArgSchemas).sort()).toEqual([
      'ui_create_exam',
      'ui_grade_exam',
      'ui_grade_exercise',
      'ui_grade_quiz',
      'ui_push_artifact',
      'ui_push_exercise',
      'ui_push_quiz',
      'ui_record_assessment',
    ]);
  });

  it('ui_push_exercise requires a session_token', () => {
    const args = {
      id: 'ex-014',
      title: 'Join two tables',
      language: 'sql',
      prompt_md: 'Write a query…',
      starter_code: 'SELECT …',
      concepts: ['inner-join'],
      difficulty: 'medium',
      tests_path: '.exercises/ex-014/tests',
    };
    expect(uiPushExerciseArgsSchema.safeParse(args).success).toBe(false);
    expect(uiPushExerciseArgsSchema.safeParse({ ...args, session_token: 'tok' }).success).toBe(
      true,
    );
  });

  it('ui_push_quiz rejects an mcq question without options', () => {
    const result = uiPushQuizArgsSchema.safeParse({
      session_token: 'tok',
      id: 'quiz-1',
      concepts: ['inner-join'],
      questions: [{ id: 'q-1', type: 'mcq', prompt_md: 'Pick one' }],
    });
    expect(result.success).toBe(false);
  });

  it('ui_create_exam rejects a coding question without a language', () => {
    const result = uiCreateExamArgsSchema.safeParse({
      session_token: 'tok',
      track: 'sql-interview',
      duration_min: 45,
      sections: [
        {
          title: 'Coding',
          questions: [
            {
              id: 'q-1',
              type: 'coding',
              prompt_md: 'Implement…',
              concepts: ['inner-join'],
              points: 10,
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('ui_record_assessment enforces mastery bounds on deltas', () => {
    const result = uiRecordAssessmentArgsSchema.safeParse({
      session_token: 'tok',
      concept_deltas: [
        { topic: 'sql', concept: 'inner-join', from: 0.4, to: 1.5, evidence: 'nope' },
      ],
    });
    expect(result.success).toBe(false);
  });
});
