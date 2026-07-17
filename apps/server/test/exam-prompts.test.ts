import { describe, expect, it } from 'vitest';
import {
  buildExamGenerateInstructions,
  buildExamGradeInstructions,
  buildExamGradingTurn,
  estimateTokens,
  EXAM_GENERATE_KICKOFF_INPUT,
  EXAM_INSTRUCTIONS_TOKEN_BUDGET,
} from '../src/prompts/index.js';

/**
 * Exam mode templates (plans/03 §6.3–6.4): token budgets, required
 * placeholders, and the integrity directives the Phase 4 E2E depends on
 * (hidden tests stay uncommitted until grading — plans/06 Phase 4 task 5).
 */

const TOKEN = 'tok_exam_sentinel_9';
const EXAM_ID = 'exam-e2e4-test';

const GENERATE_OPTS = {
  sessionToken: TOKEN,
  examId: EXAM_ID,
  trackSlug: 'sql-interview',
  durationMin: 45,
  targeting: [
    { concept: 'window-functions', name: 'Window functions', effective: 0.12 },
    { concept: 'left-join', name: 'LEFT JOIN', effective: 0.31 },
  ],
};

describe('exam-generate template', () => {
  it('carries the kickoff protocol, exam identity, targeting, and token', () => {
    const text = buildExamGenerateInstructions(GENERATE_OPTS);
    expect(text).toContain(EXAM_GENERATE_KICKOFF_INPUT);
    expect(text).toContain('EXAM GENERATION');
    expect(text).toContain(EXAM_ID);
    expect(text).toContain('sql-interview');
    expect(text).toContain('45-minute');
    expect(text).toContain('duration_min');
    expect(text).toContain(TOKEN);
    expect(text).toContain('window-functions');
    expect(text).toContain('0.12');
    expect(text).toContain('left-join');
    expect(text).toContain('ui_create_exam');
    expect(estimateTokens(text)).toBeLessThanOrEqual(EXAM_INSTRUCTIONS_TOKEN_BUDGET);
  });

  it('bakes in the exam-integrity rule and the no-tutoring rule', () => {
    const text = buildExamGenerateInstructions(GENERATE_OPTS);
    // Hidden tests + key live in the gitignored exam namespace, uncommitted.
    expect(text).toContain(`.exercises/exam-${EXAM_ID}-<question-id>/`);
    expect(text).toContain(`.exercises/exam-${EXAM_ID}-key/rubric.md`);
    expect(text).toContain('EXAM INTEGRITY');
    expect(text).toContain('UNCOMMITTED');
    expect(text).toMatch(/Do NOT `git add` or commit/);
    expect(text).toContain('a committed test is a leaked exam');
    expect(text).toMatch(/no hints, no teaching/);
    expect(text).toContain('Never reveal this token');
    // Voice rules ride every mode template (Phase 1 QA M3).
    expect(text).toContain('Learner-facing voice');
  });

  it('degrades gracefully when no mastery data exists yet', () => {
    const text = buildExamGenerateInstructions({ ...GENERATE_OPTS, targeting: [] });
    expect(text).toContain('no mastery data yet');
  });
});

describe('exam-grade template', () => {
  it('carries execution-first grading, the exact-snapshot flow, and the force-add commit', () => {
    const text = buildExamGradeInstructions({
      sessionToken: TOKEN,
      examId: EXAM_ID,
      trackSlug: 'sql-interview',
      readinessBefore: 47.5,
    });
    expect(text).toContain('EXAM GRADING');
    expect(text).toContain(EXAM_ID);
    expect(text).toContain(TOKEN);
    expect(text).toContain('ACTUALLY execute');
    expect(text).toContain('ui_grade_exam');
    expect(text).toContain('exams/<date>-sql-interview-mock.md');
    expect(text).toContain('## Readiness');
    expect(text).toContain('47.5');
    // The single exam(...) commit force-adds the gitignored workdirs.
    expect(text).toContain('exam(<topic>)');
    expect(text).toContain(`git add -f .exercises/exam-${EXAM_ID}-*`);
    expect(text).toContain('ui_record_assessment');
    expect(text).toContain('Learner-facing voice');
    expect(estimateTokens(text)).toBeLessThanOrEqual(EXAM_INSTRUCTIONS_TOKEN_BUDGET);
  });

  it('omits the readiness line when no snapshot exists', () => {
    const text = buildExamGradeInstructions({
      sessionToken: TOKEN,
      examId: EXAM_ID,
      trackSlug: 'sql-interview',
    });
    expect(text).not.toContain('Pre-exam readiness');
  });
});

describe('exam grading-turn template', () => {
  const questions = {
    track: 'sql-interview',
    duration_min: 45,
    sections: [
      {
        title: 'SQL',
        questions: [
          {
            id: 'q1',
            type: 'coding' as const,
            prompt_md: 'Join.',
            concepts: ['inner-join'],
            language: 'sql',
            points: 10,
          },
          { id: 'q2', type: 'mcq' as const, prompt_md: 'Rows?', concepts: ['left-join'], options: ['3', '5'], points: 5 },
          { id: 'q3', type: 'short' as const, prompt_md: 'Explain.', concepts: ['left-join'], points: 5 },
        ],
      },
    ],
  };

  it('lists every question with its answer, path, or NO ANSWER', () => {
    const text = buildExamGradingTurn({
      examId: EXAM_ID,
      trackSlug: 'sql-interview',
      questions,
      answers: { q1: 'SELECT 1;', q2: '5' },
      submissionPaths: { q1: `.exercises/exam-${EXAM_ID}-q1/submission.sql` },
      autoSubmitted: false,
    });
    expect(text).toContain(`exam ${EXAM_ID}`);
    expect(text).toContain(`q1 (coding, 10 pts): saved to \`.exercises/exam-${EXAM_ID}-q1/submission.sql\``);
    expect(text).toContain('q2 (mcq, 5 pts): "5"');
    expect(text).toContain('q3 (short, 5 pts): NO ANSWER');
    expect(text).toContain('ui_grade_exam');
    expect(text).not.toContain('time expired');
  });

  it('marks auto-submitted sittings and unanswered coding questions', () => {
    const text = buildExamGradingTurn({
      examId: EXAM_ID,
      trackSlug: 'sql-interview',
      questions,
      answers: {},
      submissionPaths: {},
      autoSubmitted: true,
    });
    expect(text).toContain('time expired');
    expect(text).toContain('q1 (coding, 10 pts): NO ANSWER');
  });
});
