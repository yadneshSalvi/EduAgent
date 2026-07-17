import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ExamQuestions, ExamResult } from '@eduagent/shared';
import { buildConceptResults, buildQuestionResults } from '@/lib/exam';
import { TimerDisplay } from './exam-timer';
import { QuestionPalette } from './question-palette';
import { TerminalCard } from './generation-progress';
import { ConceptBreakdown, QuestionReview } from './exam-results';

/**
 * Render smoke (server markup, no browser): the presentational exam pieces
 * produce sensible DOM from real-shaped data. The live flow (timer ticking,
 * autosave, WS transitions) is covered by the browser verification pass.
 */

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
          prompt_md: 'What is the complexity of a hash lookup?',
          concepts: ['hash-maps'],
          options: ['O(1)', 'O(n)'],
          points: 2,
        },
        {
          id: 'q2',
          type: 'short',
          prompt_md: 'Explain amortized cost.',
          concepts: ['big-o'],
          points: 3,
        },
      ],
    },
  ],
};

const RESULT: ExamResult = {
  per_question: [
    { id: 'q1', verdict: 'correct', points_awarded: 2, feedback_md: 'Yes — average case.' },
    { id: 'q2', verdict: 'incorrect', points_awarded: 0, feedback_md: 'You described worst case.' },
  ],
  total: 2,
  readiness_delta: 1.5,
};

describe('TimerDisplay', () => {
  it('renders the clock with the tone class per remaining time', () => {
    const calm = renderToStaticMarkup(<TimerDisplay msLeft={42 * 60_000 + 17_000} />);
    expect(calm).toContain('42:17');
    expect(calm).toContain('text-foreground');

    const amber = renderToStaticMarkup(<TimerDisplay msLeft={4 * 60_000} />);
    expect(amber).toContain('4:00');
    expect(amber).toContain('text-warn');

    const red = renderToStaticMarkup(<TimerDisplay msLeft={30_000} />);
    expect(red).toContain('0:30');
    expect(red).toContain('text-danger');
    expect(red).toContain('Time remaining 0:30');
  });
});

describe('QuestionPalette', () => {
  it('renders one numbered dot per question with answered/flagged states', () => {
    const html = renderToStaticMarkup(
      <QuestionPalette
        items={[
          { id: 'q1', number: 1, answered: true, flagged: false },
          { id: 'q2', number: 2, answered: false, flagged: true },
        ]}
        onJump={() => {}}
      />,
    );
    expect(html).toContain('Question 1 · answered');
    expect(html).toContain('Question 2 · unanswered · flagged');
    expect(html).toContain('bg-warn');
  });
});

describe('TerminalCard', () => {
  it('renders command, done, running lines with their prefixes', () => {
    const html = renderToStaticMarkup(
      <TerminalCard
        title="exam-generator — forked thread · cs-interviews"
        lines={[
          { id: 'cmd', text: 'eduagent exam fork --track cs-interviews', status: 'done', command: true },
          { id: 'fork', text: 'forked from your memory (142 commits)', status: 'done' },
          { id: 'write', text: 'writing hidden tests…', status: 'running' },
        ]}
        failureMessage={null}
      />,
    );
    expect(html).toContain('$');
    expect(html).toContain('forked from your memory (142 commits)');
    expect(html).toContain('writing hidden tests…');
    expect(html).toContain('chip-dots');
  });

  it('renders the failure line instead of the caret', () => {
    const html = renderToStaticMarkup(
      <TerminalCard title="t" lines={[]} failureMessage="Exam generation did not finish." />,
    );
    expect(html).toContain('✗');
    expect(html).toContain('Exam generation did not finish.');
  });
});

describe('results pieces', () => {
  const views = buildQuestionResults(QUESTIONS, RESULT, { q1: 'O(1)' });

  it('QuestionReview header shows verdict, points, and concepts', () => {
    const html = renderToStaticMarkup(<QuestionReview view={views[0]!} />);
    expect(html).toContain('correct');
    expect(html).toContain('hash-maps');
    expect(html).toContain('>2</span>');
    expect(html).toContain('aria-expanded="false"');
  });

  it('ConceptBreakdown chips carry outcome and points ratio', () => {
    const html = renderToStaticMarkup(
      <ConceptBreakdown concepts={buildConceptResults(views)} />,
    );
    expect(html).toContain('hash-maps');
    expect(html).toContain('held');
    expect(html).toContain('big-o');
    expect(html).toContain('slipped');
    expect(html).toContain('queued for review');
  });
});
