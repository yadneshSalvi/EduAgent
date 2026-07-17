import { describe, expect, it } from 'vitest';
import type { MemoryCommit, QuizPayload } from '@eduagent/shared';
import {
  initialReviewSessionStats,
  nextReviewsFromDiff,
  reviewSessionReducer,
} from './review-session';

const SRS_DIFF = [
  'diff --git a/srs/queue.yaml b/srs/queue.yaml',
  'index 111..222 100644',
  '--- a/srs/queue.yaml',
  '+++ b/srs/queue.yaml',
  '@@ -1,8 +1,8 @@',
  ' items:',
  '   - concept: inner-join',
  '     topic: sql',
  '-    due: 2026-07-16',
  '-    interval_days: 3',
  '+    due: 2026-07-23',
  '+    interval_days: 7',
  '     ease: 2.55',
  '     lapses: 0',
  '   - concept: select-basics',
  '     topic: sql',
  '     due: 2026-07-14',
  '',
].join('\n');

const OTHER_FILE_DIFF = [
  'diff --git a/topics/sql/mastery.yaml b/topics/sql/mastery.yaml',
  '--- a/topics/sql/mastery.yaml',
  '+++ b/topics/sql/mastery.yaml',
  '@@ -1,4 +1,4 @@',
  '   - concept: left-join',
  '+    due: 2026-08-01',
  '',
].join('\n');

describe('nextReviewsFromDiff', () => {
  it('parses added due lines under their concept in srs/queue.yaml', () => {
    expect(nextReviewsFromDiff(SRS_DIFF, '2026-07-16')).toEqual([
      { concept: 'inner-join', days: 7 },
    ]);
  });

  it('ignores due lines outside srs/queue.yaml and unchanged context dues', () => {
    expect(nextReviewsFromDiff(OTHER_FILE_DIFF, '2026-07-16')).toEqual([]);
  });

  it('returns [] for commits that never touched the queue', () => {
    expect(nextReviewsFromDiff('', '2026-07-16')).toEqual([]);
  });
});

const QUIZ: QuizPayload = {
  id: 'quiz-1',
  concepts: ['inner-join', 'where-clause'],
  questions: [
    { id: 'q1', type: 'mcq', prompt_md: 'Pick one', options: ['a', 'b'], answer: 'a' },
    { id: 'q2', type: 'short', prompt_md: 'Explain' },
  ],
};

const COMMIT: MemoryCommit = {
  sha: 'abc1234',
  type: 'review',
  topic: 'sql',
  headline: 'inner-join held 0.72→0.74',
  bullets: [],
  deltas: [{ concept: 'inner-join', from: 0.72, to: 0.74 }],
  stats: { filesChanged: 2, insertions: 4, deletions: 4 },
  diff: SRS_DIFF,
};

describe('reviewSessionReducer', () => {
  it('accumulates quizzes, concepts (deduped), verdicts, and commits', () => {
    let stats = initialReviewSessionStats;
    stats = reviewSessionReducer(stats, { type: 'quiz-pushed', quiz: QUIZ });
    stats = reviewSessionReducer(stats, {
      type: 'quiz-graded',
      results: [
        { question_id: 'q1', verdict: 'correct', feedback_md: '' },
        { question_id: 'q2', verdict: 'partial', feedback_md: 'close' },
      ],
    });
    stats = reviewSessionReducer(stats, {
      type: 'quiz-pushed',
      quiz: { ...QUIZ, id: 'quiz-2', concepts: ['inner-join', 'left-join'] },
    });
    stats = reviewSessionReducer(stats, { type: 'commit', commit: COMMIT, todayIso: '2026-07-16' });

    expect(stats.quizzesPushed).toBe(2);
    expect(stats.quizzesGraded).toBe(1);
    expect(stats.correct).toBe(1);
    expect(stats.partial).toBe(1);
    expect(stats.incorrect).toBe(0);
    expect(stats.concepts).toEqual(['inner-join', 'where-clause', 'left-join']);
    expect(stats.commits).toBe(1);
    expect(stats.nextReviews).toEqual([{ concept: 'inner-join', days: 7 }]);
  });

  it('later reschedules for the same concept replace earlier ones', () => {
    let stats = initialReviewSessionStats;
    stats = reviewSessionReducer(stats, { type: 'commit', commit: COMMIT, todayIso: '2026-07-16' });
    const laterDiff = SRS_DIFF.replace('+    due: 2026-07-23', '+    due: 2026-07-30');
    stats = reviewSessionReducer(stats, {
      type: 'commit',
      commit: { ...COMMIT, sha: 'def5678', diff: laterDiff },
      todayIso: '2026-07-16',
    });
    expect(stats.nextReviews).toEqual([{ concept: 'inner-join', days: 14 }]);
  });
});
