import type { MemoryCommit, QuizGradeResult, QuizPayload } from '@eduagent/shared';
import { daysUntil } from './dashboard-data';

/**
 * Review-session bookkeeping (plans/04 §5): cumulative stats across the
 * quizzes the review thread streams in, plus the "next review in Xd" chips
 * derived from the srs/queue.yaml lines of a review commit's diff.
 */

export interface NextReview {
  concept: string;
  /** Days from today until the rescheduled due date. */
  days: number;
}

/**
 * Extracts rescheduled due dates from a commit's unified diff: inside the
 * srs/queue.yaml file section, an ADDED `due:` line reschedules the concept
 * named by the nearest preceding `concept:` line (any diff prefix — the
 * concept line itself is usually unchanged context). Returns [] when the
 * commit didn't touch the queue — callers omit the chip (task contract:
 * "if derivable; else omit").
 */
export function nextReviewsFromDiff(diff: string, todayIso: string): NextReview[] {
  const results: NextReview[] = [];
  let inQueueFile = false;
  let concept: string | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inQueueFile = line.includes('srs/queue.yaml');
      concept = null;
      continue;
    }
    if (!inQueueFile) continue;
    const conceptMatch = /^[+\- ]\s*-?\s*concept:\s*([a-z0-9-]+)\s*$/.exec(line);
    if (conceptMatch) {
      concept = conceptMatch[1] ?? null;
      continue;
    }
    const dueMatch = /^\+\s*due:\s*(\d{4}-\d{2}-\d{2})\s*$/.exec(line);
    if (dueMatch && concept !== null) {
      results.push({ concept, days: daysUntil(dueMatch[1]!, todayIso) });
      concept = null;
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

export interface ReviewSessionStats {
  /** Quizzes the agent has pushed this session. */
  quizzesPushed: number;
  /** Quizzes fully graded. */
  quizzesGraded: number;
  correct: number;
  partial: number;
  incorrect: number;
  /** Distinct concepts covered, in first-seen order. */
  concepts: string[];
  /** Latest reschedules parsed from review commits (concept → days). */
  nextReviews: NextReview[];
  /** Commits landed during the session. */
  commits: number;
}

export const initialReviewSessionStats: ReviewSessionStats = {
  quizzesPushed: 0,
  quizzesGraded: 0,
  correct: 0,
  partial: 0,
  incorrect: 0,
  concepts: [],
  nextReviews: [],
  commits: 0,
};

export type ReviewSessionEvent =
  | { type: 'quiz-pushed'; quiz: QuizPayload }
  | { type: 'quiz-graded'; results: QuizGradeResult[] }
  | { type: 'commit'; commit: MemoryCommit; todayIso: string };

/** Quiz concept refs may be "topic/concept" — stats read as bare concepts. */
const bareConcept = (ref: string): string =>
  ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;

export function reviewSessionReducer(
  stats: ReviewSessionStats,
  event: ReviewSessionEvent,
): ReviewSessionStats {
  switch (event.type) {
    case 'quiz-pushed': {
      const concepts = [...stats.concepts];
      for (const ref of event.quiz.concepts) {
        const concept = bareConcept(ref);
        if (!concepts.includes(concept)) concepts.push(concept);
      }
      return { ...stats, quizzesPushed: stats.quizzesPushed + 1, concepts };
    }
    case 'quiz-graded': {
      let { correct, partial, incorrect } = stats;
      for (const result of event.results) {
        if (result.verdict === 'correct') correct++;
        else if (result.verdict === 'partial') partial++;
        else incorrect++;
      }
      return { ...stats, quizzesGraded: stats.quizzesGraded + 1, correct, partial, incorrect };
    }
    case 'commit': {
      const parsed = nextReviewsFromDiff(event.commit.diff, event.todayIso);
      const merged = new Map(stats.nextReviews.map((r) => [r.concept, r]));
      for (const reschedule of parsed) merged.set(reschedule.concept, reschedule);
      return { ...stats, commits: stats.commits + 1, nextReviews: [...merged.values()] };
    }
  }
}
