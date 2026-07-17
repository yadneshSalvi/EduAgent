'use client';

import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ArrowRight, CheckCircle2, MinusCircle, SendHorizonal, XCircle } from 'lucide-react';
import type {
  GradeVerdict,
  QuizGradeResult,
  QuizPayload,
  SubmitQuizRequest,
} from '@eduagent/shared';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/chat/markdown';
import { buildQuizSubmission } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { EMPTY_RESPONSE, QuizCard, type QuizResponse } from './quiz-card';

/**
 * Quiz flow (plans/04 §3): one question at a time with progress dots; on
 * finish ALL answers (client-checked verdicts included) POST at once, then
 * short-answer verdicts arrive via quiz.graded. Deliberately standalone —
 * driven only by props so review sessions and onboarding can embed it.
 */
interface QuizFlowProps {
  quiz: QuizPayload;
  phase: 'answering' | 'grading' | 'graded';
  results: QuizGradeResult[] | null;
  submitError?: string | null;
  onFinish: (answers: SubmitQuizRequest['answers']) => void;
}

export function QuizFlow({ quiz, phase, results, submitError, onFinish }: QuizFlowProps) {
  const reducedMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [responses, setResponses] = useState<Record<string, QuizResponse>>({});

  const questions = quiz.questions;
  const question = questions[Math.min(index, questions.length - 1)];

  if (phase !== 'answering' || !question) {
    return <QuizSummary quiz={quiz} phase={phase} responses={responses} results={results} />;
  }

  const response = responses[question.id] ?? EMPTY_RESPONSE;
  const answered = question.type === 'short' ? response.answer.trim() !== '' : response.checked;
  const isLast = index === questions.length - 1;

  const advance = () => {
    if (!answered) return;
    if (isLast) {
      const answers = Object.fromEntries(
        Object.entries(responses).map(([id, r]) => [id, r.answer]),
      );
      answers[question.id] = response.answer;
      onFinish(buildQuizSubmission(questions, answers));
    } else {
      setIndex(index + 1);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5">
        <span className="font-mono text-caption text-muted-foreground">
          question {index + 1} of {questions.length}
        </span>
        <ProgressDots
          count={questions.length}
          current={index}
          answeredIds={questions.map((q) => {
            const r = responses[q.id];
            return Boolean(r && (q.type === 'short' ? r.answer.trim() !== '' : r.checked));
          })}
        />
        <span className="flex-1" />
        {quiz.concepts.slice(0, 2).map((concept) => (
          <span
            key={concept}
            className="hidden rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground lg:inline"
          >
            {concept}
          </span>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={question.id}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -24 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <QuizCard
              question={question}
              response={response}
              onRespond={(next) => setResponses((all) => ({ ...all, [question.id]: next }))}
            />
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t px-4 py-3">
        {submitError ? (
          <p role="alert" className="min-w-0 flex-1 text-body-sm text-danger">
            {submitError}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <Button onClick={advance} disabled={!answered} className="gap-1.5">
          {isLast ? (
            <>
              Finish quiz
              <SendHorizonal className="size-3.5" aria-hidden />
            </>
          ) : (
            <>
              Next question
              <ArrowRight className="size-3.5" aria-hidden />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function ProgressDots({
  count,
  current,
  answeredIds,
}: {
  count: number;
  current: number;
  answeredIds: boolean[];
}) {
  return (
    <span aria-hidden className="flex items-center gap-1.5">
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className={cn(
            'size-1.5 rounded-full transition-colors duration-150',
            i === current
              ? 'bg-primary ring-2 ring-primary/30'
              : answeredIds[i]
                ? 'bg-primary/70'
                : 'bg-surface-2',
          )}
        />
      ))}
    </span>
  );
}

const VERDICT_META: Record<GradeVerdict, { icon: typeof CheckCircle2; className: string }> = {
  correct: { icon: CheckCircle2, className: 'text-success' },
  partial: { icon: MinusCircle, className: 'text-warn' },
  incorrect: { icon: XCircle, className: 'text-danger' },
};

/**
 * Post-submit surface: while grading, client-checked verdicts show and short
 * answers pulse; once quiz.graded lands, server verdicts win and per-question
 * feedback renders (richer walkthrough streams in chat).
 */
function QuizSummary({
  quiz,
  phase,
  responses,
  results,
}: {
  quiz: QuizPayload;
  phase: 'grading' | 'graded' | 'answering';
  responses: Record<string, QuizResponse>;
  results: QuizGradeResult[] | null;
}) {
  const rows = quiz.questions.map((question, i) => {
    const serverResult = results?.find((r) => r.question_id === question.id);
    const verdict: GradeVerdict | null =
      serverResult?.verdict ?? responses[question.id]?.verdict ?? null;
    return { question, i, verdict, feedback: serverResult?.feedback_md ?? null };
  });
  const counts = { correct: 0, partial: 0, incorrect: 0 };
  for (const row of rows) if (row.verdict) counts[row.verdict]++;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-4">
      <div className="rounded-lg border bg-surface-2/50 px-4 py-3">
        {phase === 'graded' ? (
          <p className="text-body font-medium">
            {counts.correct} of {quiz.questions.length} correct
            {counts.partial > 0 ? ` · ${counts.partial} partial` : ''}
          </p>
        ) : (
          <p className="flex items-center gap-2 text-body font-medium">
            Answers in — the tutor is grading
            <span className="chip-dots" aria-hidden>
              <span />
              <span />
              <span />
            </span>
          </p>
        )}
        <p className="mt-0.5 text-body-sm text-muted-foreground">
          {phase === 'graded'
            ? 'The tutor unpacks what this showed in chat.'
            : 'Instant checks are already in; short answers take a moment.'}
        </p>
      </div>

      <ul className="flex flex-col gap-2">
        {rows.map(({ question, i, verdict, feedback }) => {
          const meta = verdict ? VERDICT_META[verdict] : null;
          const Icon = meta?.icon;
          return (
            <li key={question.id} className="rounded-lg border p-3">
              <div className="flex items-start gap-2.5">
                {Icon && meta ? (
                  <Icon className={cn('mt-0.5 size-4 shrink-0', meta.className)} aria-hidden />
                ) : (
                  <span
                    className="chip-dots mt-1.5 shrink-0 text-muted-foreground"
                    aria-label="grading"
                  >
                    <span />
                    <span />
                    <span />
                  </span>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-mono text-caption text-muted-foreground">
                    Q{i + 1}
                    {verdict ? ` · ${verdict}` : ' · grading…'}
                  </span>
                  <Markdown content={question.prompt_md} className="text-body-sm" />
                  {feedback ? (
                    <div className="mt-1 border-l-2 border-border pl-3">
                      <Markdown content={feedback} className="text-body-sm text-muted-foreground" />
                    </div>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
