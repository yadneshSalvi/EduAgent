'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Flame,
  Loader2,
  MinusCircle,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import type { SubmitQuizRequest } from '@eduagent/shared';
import { ActivityChips } from '@/components/chat/activity-chips';
import { ChatInput } from '@/components/chat/chat-input';
import { Markdown } from '@/components/chat/markdown';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QuizFlow } from '@/components/workbench/quiz-flow';
import { useDashboard } from '@/hooks/use-dashboard';
import { useTurnStream } from '@/hooks/use-turn-stream';
import { ApiError, getReviewQueue, interruptThread, startReview, submitQuiz } from '@/lib/api';
import { daysUntil, formatShortDate, reviewEstimateMinutes } from '@/lib/dashboard-data';
import {
  initialReviewSessionStats,
  reviewSessionReducer,
  type ReviewSessionStats,
} from '@/lib/review-session';
import { cn } from '@/lib/utils';

/**
 * Review (plans/04 §5): focused single-column flow. Queue header ("N due ·
 * est. M min") → start → the review thread streams quizzes in (QuizFlow in
 * card form) → per-item feedback + "next review in Xd" chips parsed from the
 * review commit → session summary. Duolingo pace, Anki rigor.
 */

/** Local calendar date (learner's machine ≈ learner's timezone). */
function todayIso(): string {
  return new Date().toLocaleDateString('en-CA');
}

// ---------------------------------------------------------------------------
// Queue view
// ---------------------------------------------------------------------------

function QueueView({ onStarted }: { onStarted: (threadId: string) => void }) {
  const queueQuery = useQuery({
    queryKey: ['review', 'queue'],
    queryFn: ({ signal }) => getReviewQueue(signal),
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [nothingDue, setNothingDue] = useState(false);

  if (queueQuery.isPending) {
    return (
      <div className="mx-auto flex w-full max-w-xl animate-pulse flex-col gap-4" aria-hidden>
        <div className="h-28 rounded-lg border bg-surface" />
        <div className="h-14 rounded-lg border bg-surface" />
        <div className="h-14 rounded-lg border bg-surface" />
      </div>
    );
  }
  if (queueQuery.isError) {
    return (
      <ErrorState
        title="The review queue can't load"
        description="The agent host didn't answer. Your schedule is intact — retry hits the same endpoint."
        detail={queueQuery.error instanceof Error ? queueQuery.error.message : undefined}
        onRetry={() => void queueQuery.refetch()}
      />
    );
  }

  const queue = queueQuery.data;
  const due = queue.dueToday + queue.overdue;
  const today = todayIso();

  if (due === 0 || nothingDue) {
    return (
      <EmptyState
        icon={RotateCcw}
        title="Nothing due — your memory is holding."
        description="Reviews land here on a spaced-repetition schedule, each one attacked from a new angle. Learn something new and it joins the queue."
        example={
          queue.items[0]
            ? `${queue.items[0].concept} · due ${formatShortDate(queue.items[0].due)}`
            : 'inner-join · due in 3 days · a new angle each time'
        }
        cta={{ label: 'Learn something new', href: '/app/learn' }}
      />
    );
  }

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      const { threadId } = await startReview();
      onStarted(threadId);
    } catch (err) {
      setStarting(false);
      if (err instanceof ApiError && err.code === 'nothing_due') {
        setNothingDue(true);
        return;
      }
      setStartError(err instanceof Error ? err.message : 'Starting the session failed.');
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <section className="flex flex-col gap-4 rounded-lg border bg-surface p-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="font-display text-h3 font-medium">
            <span className="numeric">{due}</span> due · est.{' '}
            <span className="numeric">{reviewEstimateMinutes(due)}</span> min
          </h2>
          {queue.overdue > 0 ? (
            <Badge variant="warn" className="numeric">
              {queue.overdue} overdue
            </Badge>
          ) : null}
        </div>
        <p className="text-body-sm text-muted-foreground">
          The tutor reads your memory and quizzes each concept from a fresh angle — never the
          same flashcard twice.
        </p>
        <Button size="lg" className="gap-2" disabled={starting} onClick={() => void start()}>
          {starting ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <RotateCcw className="size-4" aria-hidden />
          )}
          Start review
        </Button>
        {startError ? (
          <p role="alert" className="text-body-sm text-danger">
            {startError}
          </p>
        ) : null}
      </section>

      <ul className="flex flex-col gap-2">
        {queue.items.map((item) => {
          const overdueDays = -daysUntil(item.due, today);
          return (
            <li
              key={`${item.topic}/${item.concept}`}
              className="flex items-center gap-3 rounded-lg border bg-surface px-4 py-3"
            >
              <span className="font-mono text-body-sm">{item.concept}</span>
              <span className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground">
                {item.topic}
              </span>
              <span className="flex-1" />
              <span
                className={cn(
                  'font-mono text-caption',
                  overdueDays > 0 ? 'text-warn' : 'text-muted-foreground',
                )}
              >
                {overdueDays > 0
                  ? `${overdueDays}d overdue`
                  : `due ${formatShortDate(item.due)}`}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live session
// ---------------------------------------------------------------------------

function VerdictCounts({ stats }: { stats: ReviewSessionStats }) {
  return (
    <span className="flex items-center gap-3 font-mono text-caption">
      <span className="flex items-center gap-1 text-success">
        <CheckCircle2 className="size-3.5" aria-hidden />
        <span className="numeric">{stats.correct}</span>
      </span>
      {stats.partial > 0 ? (
        <span className="flex items-center gap-1 text-warn">
          <MinusCircle className="size-3.5" aria-hidden />
          <span className="numeric">{stats.partial}</span>
        </span>
      ) : null}
      {stats.incorrect > 0 ? (
        <span className="flex items-center gap-1 text-danger">
          <XCircle className="size-3.5" aria-hidden />
          <span className="numeric">{stats.incorrect}</span>
        </span>
      ) : null}
    </span>
  );
}

function NextReviewChips({ stats }: { stats: ReviewSessionStats }) {
  if (stats.nextReviews.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {stats.nextReviews.map(({ concept, days }) => (
        <span
          key={concept}
          className="flex items-center gap-1.5 rounded-sm bg-surface-2 px-2 py-1 font-mono text-caption text-muted-foreground"
        >
          <CalendarClock className="size-3 text-primary" aria-hidden />
          {concept} · next review in <span className="numeric text-foreground">{days}d</span>
        </span>
      ))}
    </div>
  );
}

function SessionSummary({ stats, onDone }: { stats: ReviewSessionStats; onDone: () => void }) {
  const { data: dashboard } = useDashboard();
  return (
    <section className="flex flex-col gap-4 rounded-lg border bg-surface p-6">
      <h2 className="font-display text-h3 font-medium italic">Session banked.</h2>
      <p className="text-body-sm text-muted-foreground">
        {stats.quizzesGraded > 0
          ? `${stats.quizzesGraded} quiz${stats.quizzesGraded === 1 ? '' : 'zes'} graded — every answer became mastery evidence in your memory.`
          : 'The tutor recorded this session in your memory.'}
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <VerdictCounts stats={stats} />
        {dashboard && dashboard.user.streakDays > 0 ? (
          <span className="flex items-center gap-1 font-mono text-caption text-warn">
            <Flame className="size-3.5" aria-hidden />
            {/* One flex item — gap-1 must not split "13" from "-day streak". */}
            <span>
              <span className="numeric">{dashboard.user.streakDays}</span>
              -day streak
            </span>
          </span>
        ) : null}
      </div>
      {stats.concepts.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {stats.concepts.map((concept) => (
            <span
              key={concept}
              className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
            >
              {concept}
            </span>
          ))}
        </div>
      ) : null}
      <NextReviewChips stats={stats} />
      <div className="mt-1 flex flex-wrap gap-3">
        <Button asChild className="gap-1.5">
          <Link href="/app">
            Back to dashboard
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Button>
        <Button variant="outline" onClick={onDone}>
          Review queue
        </Button>
      </div>
    </section>
  );
}

function ReviewSession({ threadId, onExit }: { threadId: string; onExit: () => void }) {
  const { publishCommit } = useMemoryCommits();
  const queryClient = useQueryClient();
  const [stats, dispatchStats] = useReducer(reviewSessionReducer, initialReviewSessionStats);
  const [ended, setEnded] = useState(false);

  const stream = useTurnStream(threadId, {
    onCommit: (commit) => {
      publishCommit(commit);
      dispatchStats({ type: 'commit', commit, todayIso: todayIso() });
    },
  });
  const { state, send, dispatch } = stream;
  const quiz = state.workbench.quiz;

  // Feed the cumulative session stats from the per-thread quiz slice.
  const seenQuizIds = useRef(new Set<string>());
  useEffect(() => {
    const payload = quiz.payload;
    if (payload && !seenQuizIds.current.has(payload.id)) {
      seenQuizIds.current.add(payload.id);
      dispatchStats({ type: 'quiz-pushed', quiz: payload });
    }
  }, [quiz.payload]);

  const gradedQuizIds = useRef(new Set<string>());
  useEffect(() => {
    const payload = quiz.payload;
    if (
      payload &&
      quiz.phase === 'graded' &&
      quiz.results &&
      !gradedQuizIds.current.has(payload.id)
    ) {
      gradedQuizIds.current.add(payload.id);
      dispatchStats({ type: 'quiz-graded', quizId: payload.id, results: quiz.results });
    }
  }, [quiz.phase, quiz.results, quiz.payload]);

  const onFinishQuiz = (answers: SubmitQuizRequest['answers']) => {
    const quizId = quiz.payload?.id;
    if (!quizId) return;
    // Client-checked mcq/predict verdicts count immediately; the server's
    // quiz.graded results overwrite per question (dedupe lives in the reducer).
    dispatchStats({ type: 'answers-submitted', quizId, answers });
    dispatch({ type: 'quiz-submitted' });
    submitQuiz(quizId, { answers }).catch((err: unknown) => {
      dispatch({
        type: 'quiz-submit-failed',
        message:
          err instanceof Error ? err.message : "The answers didn't reach the tutor — try again.",
      });
    });
  };

  const endSession = () => {
    setEnded(true);
    if (state.turnStatus !== 'idle') {
      interruptThread(threadId).catch(() => undefined);
    }
    void queryClient.invalidateQueries({ queryKey: ['review', 'queue'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  // Most review turns are tutor-driven (grading, next item), so a dead turn
  // often has no user message to resend — a nudge restarts the loop instead.
  const retryTurn = () => {
    const lastUser = [...state.items].reverse().find((item) => item.role === 'user');
    send(lastUser?.text ?? 'Keep the review going — pick up where you left off.');
  };

  if (ended) {
    return (
      <div className="mx-auto w-full max-w-xl">
        <SessionSummary stats={stats} onDone={onExit} />
      </div>
    );
  }

  const lastAgentText = [...state.items].reverse().find((item) => item.role === 'agent')?.text;
  const turnInFlight = state.turnStatus !== 'idle';

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl min-h-0 flex-col gap-4">
      <header className="flex shrink-0 items-center gap-3">
        <Badge variant="accent" className="font-mono lowercase">
          review
        </Badge>
        <span className="font-mono text-caption text-muted-foreground">
          item <span className="numeric">{Math.max(1, stats.quizzesPushed)}</span> ·{' '}
          <span className="numeric">{stats.quizzesGraded}</span> graded
        </span>
        <VerdictCounts stats={stats} />
        <span className="flex-1" />
        <Button size="sm" variant="outline" onClick={endSession}>
          End session
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-2">
        {state.connection === 'not-found' || state.connection === 'failed' ? (
          <ErrorState
            title="The session dropped"
            description="The live connection to the tutor failed. Your memory is intact — head back and start again."
            onRetry={onExit}
            retryLabel="Back to queue"
          />
        ) : (
          <>
            {/* The tutor's voice — latest completed message, then live stream. */}
            {lastAgentText && state.streamingText === '' ? (
              <div className="rounded-lg border bg-surface p-5">
                <Markdown content={lastAgentText} className="text-body-sm" />
              </div>
            ) : null}
            {state.streamingText !== '' ? (
              <div className="rounded-lg border bg-surface p-5" aria-live="polite">
                <Markdown content={state.streamingText} className="text-body-sm" />
              </div>
            ) : null}

            {turnInFlight && state.streamingText === '' ? (
              <div className="flex items-center gap-2 px-1 text-body-sm text-muted-foreground">
                <span className="chip-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                <span className="font-serif italic">
                  {quiz.phase === 'grading'
                    ? 'Grading — the next item lands in the same breath…'
                    : 'The tutor is reading your memory…'}
                </span>
              </div>
            ) : null}
            <ActivityChips chips={state.activityChips} />

            {state.error ? (
              <div
                role="alert"
                className="flex items-center justify-between gap-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3"
              >
                <p className="text-body-sm">{state.error.message}</p>
                {state.error.retryable ? (
                  <Button size="sm" variant="outline" onClick={retryTurn} className="shrink-0 gap-1.5">
                    <RefreshCw className="size-3.5" aria-hidden />
                    Retry
                  </Button>
                ) : null}
              </div>
            ) : null}

            {quiz.payload ? (
              <div className="min-h-[320px] rounded-lg border bg-surface">
                <QuizFlow
                  key={quiz.payload.id}
                  quiz={quiz.payload}
                  phase={quiz.phase}
                  results={quiz.results}
                  submitError={quiz.submitError}
                  onFinish={onFinishQuiz}
                />
              </div>
            ) : null}

            <NextReviewChips stats={stats} />
          </>
        )}
      </div>

      {state.connection === 'not-found' || state.connection === 'failed' ? null : (
        <div className="shrink-0 rounded-lg border bg-surface">
          <ChatInput
            onSend={send}
            onInterrupt={() => {
              interruptThread(threadId).catch(() => undefined);
            }}
            turnInFlight={turnInFlight}
            connection={state.connection}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function ReviewFlow() {
  const [threadId, setThreadId] = useState<string | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-b px-8 py-6">
        <h1 className="font-display text-h2 font-medium tracking-tight">Review</h1>
        <p className="text-body-sm text-muted-foreground">
          A daily queue that keeps mastery from decaying — questions generated fresh from your
          memory.
        </p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col p-8">
        {threadId ? (
          <ReviewSession threadId={threadId} onExit={() => setThreadId(null)} />
        ) : (
          <div className="flex flex-1 items-start justify-center">
            <QueueView onStarted={setThreadId} />
          </div>
        )}
      </div>
    </div>
  );
}
