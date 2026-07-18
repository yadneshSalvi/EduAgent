'use client';

import { useState } from 'react';
import { Loader2, RotateCcw, ScanSearch } from 'lucide-react';
import type { ExamDto } from '@eduagent/shared';
import { ActivityChips } from '@/components/chat/activity-chips';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTurnStream } from '@/hooks/use-turn-stream';
import { ApiError, submitExam } from '@/lib/api';
import { examDeadlineMs } from '@/lib/exam';

/**
 * The submitted → graded wait (plans/04 §6): calm, honest about what's
 * happening (the examiner runs hidden tests on the same forked thread), with
 * the thread's live activity. A grading turn.error offers a retry — POSTing
 * submit again re-kicks grading (plans/03 §3.5).
 */

/** Live activity off the exam thread's socket while grading runs. */
function GradingActivity({ threadId }: { threadId: string }) {
  const { state } = useTurnStream(threadId);
  return <ActivityChips chips={state.activityChips} />;
}

export function GradingState({
  exam,
  threadId,
  failure,
  onRetried,
}: {
  exam: ExamDto;
  threadId: string | null;
  /** Grading turn.error surfaced by the orchestrator (user socket). */
  failure: { message: string } | null;
  onRetried: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // Submitted after the deadline ⇒ the sweep collected the autosaves.
  const autoSubmitted =
    exam.submittedAt !== null &&
    exam.startedAt !== null &&
    new Date(exam.submittedAt).getTime() >= examDeadlineMs(exam.startedAt, exam.durationMin);

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      await submitExam(exam.id, exam.answers ?? {});
      onRetried();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // "being graded" — a grading turn is already in flight; that IS progress.
        onRetried();
        return;
      }
      setRetryError(err instanceof Error ? err.message : 'Retry failed.');
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <section
        aria-label="Exam grading"
        className="flex w-full max-w-lg flex-col gap-5 rounded-lg border bg-surface p-8"
      >
        <div className="flex items-center gap-3">
          <Badge variant="warn" className="font-mono lowercase">
            grading
          </Badge>
          <span className="font-mono text-caption text-muted-foreground">
            mock exam · {exam.trackSlug}
          </span>
        </div>

        {failure ? (
          <>
            <h2 className="font-display text-h3 font-medium">Grading didn&apos;t finish.</h2>
            <p className="text-body-sm text-muted-foreground">
              The examiner&apos;s grading turn died mid-flight. Your answers are safe on the
              server — retrying hands them straight back to the examiner.
            </p>
            <p className="rounded-sm bg-surface-2 px-3 py-1.5 font-mono text-caption text-muted-foreground">
              {failure.message}
            </p>
            <Button className="gap-2 self-start" disabled={retrying} onClick={() => void retry()}>
              {retrying ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <RotateCcw className="size-4" aria-hidden />
              )}
              Retry grading
            </Button>
            {retryError ? (
              <p role="alert" className="text-body-sm text-danger">
                {retryError}
              </p>
            ) : null}
          </>
        ) : (
          <>
            <div className="flex items-start gap-4">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-accent-soft text-primary-legible">
                <ScanSearch className="size-6" aria-hidden />
              </div>
              <div className="flex flex-col gap-1.5">
                <h2 className="font-display text-h3 font-medium italic">
                  The examiner is grading.
                </h2>
                <p className="text-body-sm text-muted-foreground">
                  {autoSubmitted
                    ? 'Time ran out, so your saved answers were submitted for you. Now your code is running against the hidden tests, and every answer is being weighed against your memory.'
                    : 'Your code is running against the hidden tests, and every answer is being weighed against your memory. Results land here the moment they exist.'}
                </p>
              </div>
            </div>
            <div className="flex min-h-8 flex-col gap-2">
              {threadId ? <GradingActivity threadId={threadId} /> : null}
              <span className="flex items-center gap-2 font-mono text-caption text-muted-foreground">
                <span className="chip-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                running hidden tests
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
