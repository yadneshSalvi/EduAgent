'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import type { ExamStatus } from '@eduagent/shared';
import { useUserSocketEvents } from '@/components/memory/memory-commit-provider';
import { ErrorState } from '@/components/shared/error-state';
import { Badge } from '@/components/ui/badge';
import { ApiError, getExam } from '@/lib/api';
import { EXAM_STATUS_LABEL, pollIntervalMs } from '@/lib/exam';
import { ExamReady } from './exam-ready';
import { ExamResults } from './exam-results';
import { ExamRoom } from './exam-room';
import { GenerationProgress } from './generation-progress';
import { GradingState } from './grading-state';

/**
 * /app/exam/[examId] orchestrator (plans/04 §6): one screen that follows the
 * server's state machine — draft (generation) → ready → in_progress (the
 * room) → submitted (grading) → graded (results). WS user-socket events are
 * the fast path; polling GET /api/exams/:id is the sanctioned fallback
 * (plans/03 §3.5), including sweep-driven auto-submits the client never asks
 * for. Renders full-screen — the sidebar shell stays out (distraction-free).
 */

const STATUS_BADGE: Record<ExamStatus, 'secondary' | 'accent' | 'warn' | 'success'> = {
  draft: 'secondary',
  ready: 'accent',
  in_progress: 'warn',
  submitted: 'warn',
  graded: 'success',
};

export function ExamView({ examId }: { examId: string }) {
  const queryClient = useQueryClient();
  const [turnFailure, setTurnFailure] = useState<{ message: string } | null>(null);

  const examQuery = useQuery({
    queryKey: ['exams', examId],
    queryFn: ({ signal }) => getExam(examId, signal),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
    refetchInterval: (query) => pollIntervalMs(query.state.data, Date.now()),
  });
  const exam = examQuery.data;

  // The forked exam thread — generation/grading activity streams on its socket.
  const threadId = exam?.threadId ?? null;

  // Fast path: exam.created / exam.graded / the exam thread's turn lifecycle.
  useUserSocketEvents((event) => {
    if (
      (event.type === 'exam.created' || event.type === 'exam.graded') &&
      event.examId === examId
    ) {
      void queryClient.invalidateQueries({ queryKey: ['exams'] });
    }
    if (threadId === null || !('threadId' in event) || event.threadId !== threadId) return;
    if (event.type === 'turn.error') {
      setTurnFailure({ message: event.message });
    }
    if (event.type === 'turn.completed') {
      void queryClient.invalidateQueries({ queryKey: ['exams', examId] });
    }
  });

  // A settled failure belongs to one status — moving on clears it.
  const status = exam?.status;
  useEffect(() => setTurnFailure(null), [status]);

  const refetchExam = () => {
    void queryClient.invalidateQueries({ queryKey: ['exams', examId] });
    void queryClient.invalidateQueries({ queryKey: ['exams'] });
  };

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b px-6">
        <Link
          href="/app"
          className="rounded-sm font-display text-h4 font-semibold tracking-tight"
        >
          EduAgent
        </Link>
        {exam ? (
          <span className="flex min-w-0 items-center gap-2.5 font-mono text-caption text-muted-foreground">
            <span className="truncate">mock exam · {exam.trackSlug}</span>
            <Badge variant={STATUS_BADGE[exam.status]} className="font-mono lowercase">
              {EXAM_STATUS_LABEL[exam.status]}
            </Badge>
          </span>
        ) : null}
        <span className="flex-1" />
        {exam?.status === 'in_progress' ? (
          <span className="hidden font-mono text-caption text-muted-foreground sm:inline">
            server-timed · answers autosave
          </span>
        ) : (
          <Link
            href="/app/exam"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-body-sm text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            Back to exams
          </Link>
        )}
      </header>

      {examQuery.isError ? (
        <div className="flex flex-1 items-center justify-center p-8">
          {examQuery.error instanceof ApiError && examQuery.error.status === 404 ? (
            <ErrorState
              title="No such exam"
              description="This exam doesn't exist or isn't yours. Your history lists every exam you've taken."
              onRetry={undefined}
              secondary={
                <Link
                  href="/app/exam"
                  className="rounded-md border px-4 py-2 text-body-sm transition-colors duration-150 hover:bg-surface-2"
                >
                  Back to exams
                </Link>
              }
            />
          ) : (
            <ErrorState
              title="The exam can't load"
              description="The agent host didn't answer. Your exam state is on the server, safe."
              detail={examQuery.error instanceof Error ? examQuery.error.message : undefined}
              onRetry={() => void examQuery.refetch()}
            />
          )}
        </div>
      ) : exam === undefined ? (
        <div className="flex flex-1 items-center justify-center p-8" aria-hidden>
          <div className="h-72 w-full max-w-xl animate-pulse rounded-lg border bg-surface" />
        </div>
      ) : exam.status === 'draft' ? (
        <GenerationProgress exam={exam} threadId={threadId} failure={turnFailure} />
      ) : exam.status === 'ready' ? (
        <ExamReady exam={exam} onStarted={refetchExam} />
      ) : exam.status === 'in_progress' ? (
        <ExamRoom key={exam.id} exam={exam} onStatusChange={refetchExam} />
      ) : exam.status === 'submitted' ? (
        <GradingState exam={exam} threadId={threadId} failure={turnFailure} onRetried={refetchExam} />
      ) : (
        <ExamResults exam={exam} />
      )}
    </div>
  );
}
