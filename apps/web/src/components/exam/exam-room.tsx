'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Check, Flag, Loader2, Send, TimerOff } from 'lucide-react';
import type { ExamAnswers, ExamDto, ExamQuestion } from '@eduagent/shared';
import { Markdown } from '@/components/chat/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError, saveExamAnswers, submitExam } from '@/lib/api';
import {
  applyAnswer,
  autosaveDue,
  buildPalette,
  examDeadlineMs,
  flattenQuestions,
  loadExamAnswers,
  loadExamFlags,
  mergeAnswers,
  saveExamAnswersLocal,
  saveExamFlags,
  totalPoints,
  unansweredCount,
  type AutosaveClock,
  type FlatQuestion,
} from '@/lib/exam';
import { MONACO_FONT_FAMILY, defineEduAgentTheme } from '@/lib/monaco-theme';
import { monacoLanguage } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { ExamTimer } from './exam-timer';
import { QuestionPalette } from './question-palette';

/**
 * The timed exam room (plans/04 §6): distraction-free, sticky header with the
 * server-deadline countdown + question palette, sections below. Answers
 * persist to localStorage on every change and autosave to the server on a
 * 15s heartbeat + a short debounce. Expiry never submits from the client —
 * the server sweep does; the room locks and observes.
 */

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-surface font-mono text-caption text-muted-foreground">
      loading editor…
    </div>
  ),
});

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const QUESTION_TYPE_LABEL: Record<ExamQuestion['type'], string> = {
  coding: 'coding',
  mcq: 'multiple choice',
  short: 'short answer',
};

function McqAnswer({
  question,
  answer,
  locked,
  onAnswer,
}: {
  question: ExamQuestion;
  answer: string;
  locked: boolean;
  onAnswer: (value: string) => void;
}) {
  return (
    <div role="radiogroup" aria-label="Answer options" className="flex flex-col gap-2">
      {(question.options ?? []).map((option) => {
        const picked = answer === option;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={picked}
            disabled={locked}
            onClick={() => onAnswer(picked ? '' : option)}
            className={cn(
              'flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-body-sm transition-colors duration-150',
              picked ? 'border-primary bg-accent-soft/30' : !locked && 'hover:border-primary/50 hover:bg-surface-2',
              locked && 'cursor-default opacity-70',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'size-3.5 shrink-0 rounded-full border-2',
                picked ? 'border-primary bg-primary' : 'border-border',
              )}
            />
            <span className="min-w-0 flex-1">{option}</span>
          </button>
        );
      })}
    </div>
  );
}

function CodingAnswer({
  question,
  value,
  locked,
  onChange,
}: {
  question: ExamQuestion;
  value: string;
  locked: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="h-[280px] overflow-hidden rounded-md border">
        <MonacoEditor
          language={monacoLanguage(question.language ?? 'plaintext')}
          value={value}
          theme="eduagent-dark"
          beforeMount={defineEduAgentTheme}
          onMount={(editor) => {
            // Same as the workbench (QA finding F9): the read-only bubble
            // lingers in a global alert node — the locked state is already
            // carried by the expiry overlay.
            editor.getContribution('editor.contrib.readOnlyMessageController')?.dispose();
          }}
          onChange={(next) => onChange(next ?? '')}
          height="100%"
          options={{
            readOnly: locked,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            fontSize: 13,
            fontFamily: MONACO_FONT_FAMILY,
            padding: { top: 12, bottom: 12 },
            lineNumbers: 'on',
            folding: false,
            renderLineHighlight: 'line',
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            overviewRulerLanes: 0,
            contextmenu: false,
            tabSize: 2,
          }}
        />
      </div>
      <p className="font-mono text-caption text-muted-foreground">
        {question.language} · graded by running hidden tests against your code
      </p>
    </div>
  );
}

function QuestionCard({
  entry,
  answer,
  flagged,
  locked,
  onAnswer,
  onToggleFlag,
}: {
  entry: FlatQuestion;
  answer: string;
  flagged: boolean;
  locked: boolean;
  onAnswer: (value: string) => void;
  onToggleFlag: () => void;
}) {
  const { question, number } = entry;
  return (
    <article
      id={`question-${question.id}`}
      aria-label={`Question ${number}`}
      className="scroll-mt-44 rounded-lg border bg-surface"
    >
      <header className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <span className="font-mono text-body-sm font-semibold">
          Q<span className="numeric">{number}</span>
        </span>
        <Badge variant="secondary" className="font-mono lowercase">
          {QUESTION_TYPE_LABEL[question.type]}
        </Badge>
        {question.concepts.map((concept) => (
          <span
            key={concept}
            className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
          >
            {concept}
          </span>
        ))}
        <span className="flex-1" />
        <span className="font-mono text-caption text-muted-foreground">
          <span className="numeric">{question.points}</span> pts
        </span>
        <button
          type="button"
          aria-pressed={flagged}
          aria-label={flagged ? `Unflag question ${number}` : `Flag question ${number} for review`}
          title={flagged ? 'Unflag' : 'Flag for review'}
          onClick={onToggleFlag}
          className={cn(
            'rounded-md p-1.5 transition-colors duration-150',
            flagged
              ? 'bg-warn/15 text-warn'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
          )}
        >
          <Flag className="size-4" aria-hidden fill={flagged ? 'currentColor' : 'none'} />
        </button>
      </header>

      <div className="flex flex-col gap-4 p-5">
        <Markdown content={question.prompt_md} className="text-body-sm" />
        {question.type === 'mcq' ? (
          <McqAnswer question={question} answer={answer} locked={locked} onAnswer={onAnswer} />
        ) : question.type === 'coding' ? (
          <CodingAnswer
            question={question}
            value={answer !== '' ? answer : (question.starter_code ?? '')}
            locked={locked}
            onChange={onAnswer}
          />
        ) : (
          <textarea
            rows={4}
            value={answer}
            disabled={locked}
            onChange={(event) => onAnswer(event.target.value)}
            aria-label={`Answer to question ${number}`}
            placeholder="Your answer — the examiner grades it against your memory."
            className="w-full resize-y rounded-md border bg-background px-3 py-2 text-body-sm outline-none transition-colors duration-150 focus:border-ring disabled:opacity-70"
          />
        )}
      </div>
    </article>
  );
}

function SaveTick({ saveState, expired }: { saveState: SaveState; expired: boolean }) {
  if (expired) return null;
  return (
    <span
      className="flex items-center gap-1 font-mono text-caption text-muted-foreground"
      aria-live="polite"
    >
      {saveState === 'saving' ? (
        <>
          <Loader2 className="size-3 animate-spin" aria-hidden />
          saving
        </>
      ) : saveState === 'saved' ? (
        <>
          <Check className="size-3 text-success" aria-hidden />
          saved
        </>
      ) : saveState === 'error' ? (
        <span className="text-warn">autosave failed — retrying</span>
      ) : (
        'autosaves as you type'
      )}
    </span>
  );
}

function SubmitDialog({
  unanswered,
  total,
  submitting,
  submitError,
  onConfirm,
  onCancel,
}: {
  unanswered: number;
  total: number;
  submitting: boolean;
  submitError: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Submit exam"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border bg-surface p-6 shadow-overlay">
        <h2 className="font-display text-h3 font-medium">Submit your exam?</h2>
        <p className="text-body-sm text-muted-foreground">
          {unanswered > 0 ? (
            <>
              <span className="numeric font-medium text-warn">{unanswered}</span> of{' '}
              <span className="numeric">{total}</span>
              {' questions are unanswered — they’ll score zero. Submitting hands everything to the examiner for grading.'}
            </>
          ) : (
            <>
              All <span className="numeric">{total}</span> questions answered. Submitting hands
              everything to the examiner for grading.
            </>
          )}
        </p>
        {submitError ? (
          <p role="alert" className="text-body-sm text-danger">
            {submitError}
          </p>
        ) : null}
        <div className="flex justify-end gap-3">
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            Keep working
          </Button>
          <Button onClick={onConfirm} disabled={submitting} className="gap-1.5">
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <Send className="size-3.5" aria-hidden />
            )}
            Submit for grading
          </Button>
        </div>
      </div>
    </div>
  );
}

function ExpiredOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-6">
      <div
        role="alert"
        className="flex w-full max-w-md flex-col items-center gap-4 rounded-lg border bg-surface p-8 text-center shadow-overlay"
      >
        <div className="flex size-12 items-center justify-center rounded-md bg-warn/15 text-warn">
          <TimerOff className="size-6" aria-hidden />
        </div>
        <h2 className="font-display text-h3 font-medium">Time&apos;s up.</h2>
        <p className="text-body-sm text-muted-foreground">
          The deadline is the server&apos;s, and it just passed. Your saved answers are being
          submitted to the examiner — nothing you typed is lost.
        </p>
        <span className="flex items-center gap-2 font-mono text-caption text-muted-foreground">
          <span className="chip-dots" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          collecting your autosaved answers
        </span>
      </div>
    </div>
  );
}

export function ExamRoom({
  exam,
  onStatusChange,
}: {
  exam: ExamDto;
  /** The room saw a state transition (submit, sweep, 409) — refetch the DTO. */
  onStatusChange: () => void;
}) {
  const questions = exam.questions;
  const startedAt = exam.startedAt;
  const flat = useMemo(
    () => (questions ? flattenQuestions(questions) : []),
    [questions],
  );

  const [answers, setAnswers] = useState<ExamAnswers>(() =>
    mergeAnswers(exam.answers, loadExamAnswers(exam.id)),
  );
  const [flags, setFlags] = useState<ReadonlySet<string>>(() => new Set(loadExamFlags(exam.id)));
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [expired, setExpired] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const answersRef = useRef(answers);
  answersRef.current = answers;
  const expiredRef = useRef(expired);
  expiredRef.current = expired;
  const clockRef = useRef<AutosaveClock>({ dirtySince: null, lastSaveAt: Date.now() });
  const savingRef = useRef(false);
  const retryHoldUntilRef = useRef(0);

  const persist = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaveState('saving');
    try {
      await saveExamAnswers(exam.id, answersRef.current);
      clockRef.current = { dirtySince: null, lastSaveAt: Date.now() };
      setSaveState('saved');
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // deadline_passed → the room locks and waits for the sweep;
        // invalid_state → the status moved under us (sweep already submitted).
        if (err.code === 'deadline_passed') setExpired(true);
        onStatusChange();
        return;
      }
      // Transient failure: stay dirty so a later tick retries, but hold off
      // 5s — a persistent failure must not hammer the host every second.
      retryHoldUntilRef.current = Date.now() + 5000;
      setSaveState('error');
    } finally {
      savingRef.current = false;
    }
  }, [exam.id, onStatusChange]);

  // The 1s autosave ticker: debounce after typing, 15s heartbeat under
  // continuous typing (autosaveDue, lib/exam.ts).
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      if (
        !expiredRef.current &&
        now >= retryHoldUntilRef.current &&
        autosaveDue(clockRef.current, now)
      ) {
        void persist();
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [persist]);

  // Local draft persists post-render (setAnswer is a pure functional update).
  useEffect(() => {
    saveExamAnswersLocal(exam.id, answers);
  }, [exam.id, answers]);

  if (!questions || startedAt === null) return null;

  const deadlineMs = examDeadlineMs(startedAt, exam.durationMin);
  const palette = buildPalette(flat, answers, flags);
  const answered = palette.filter((item) => item.answered).length;
  const unanswered = unansweredCount(flat, answers);

  const setAnswer = (questionId: string, value: string) => {
    if (expiredRef.current) return;
    // Functional update (QA F4): two answers landing in the same tick both
    // survive — a snapshot-based merge would drop the first.
    setAnswers((current) => applyAnswer(current, questionId, value));
    clockRef.current.dirtySince ??= Date.now();
  };

  const toggleFlag = (questionId: string) => {
    setFlags((current) => {
      const next = new Set(current);
      if (next.has(questionId)) next.delete(questionId);
      else next.add(questionId);
      saveExamFlags(exam.id, next);
      return next;
    });
  };

  const jumpTo = (questionId: string) => {
    document
      .getElementById(`question-${questionId}`)
      ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const submit = async () => {
    setSubmitting(true);
    setSubmitError(null);
    try {
      await submitExam(exam.id, answersRef.current);
      onStatusChange();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Already submitted / being graded — follow the server's state.
        onStatusChange();
        return;
      }
      setSubmitting(false);
      setSubmitError(err instanceof Error ? err.message : 'Submitting failed — try again.');
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-40 border-b bg-surface/90 backdrop-blur">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-caption text-muted-foreground">
                <span className="numeric text-foreground">{answered}</span>/
                <span className="numeric">{flat.length}</span> answered ·{' '}
                <span className="numeric">{totalPoints(questions)}</span> pts total
              </span>
              <SaveTick saveState={saveState} expired={expired} />
            </div>
            <QuestionPalette items={palette} onJump={jumpTo} />
          </div>
          <ExamTimer
            deadlineMs={deadlineMs}
            onExpire={() => {
              setExpired(true);
              // Flush keystrokes still inside the debounce window — the
              // server accepts autosaves for EXAM_GRACE_MS past the deadline
              // precisely so the sweep grades what was typed last.
              if (clockRef.current.dirtySince !== null) void persist();
            }}
          />
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={expired || submitting}
            className="gap-1.5"
          >
            <Send className="size-3.5" aria-hidden />
            Submit
          </Button>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-8">
        {questions.sections.map((section, sectionIndex) => (
          <section key={sectionIndex} aria-label={section.title} className="flex flex-col gap-4">
            <h2 className="flex items-baseline gap-3 border-b pb-2">
              <span className="font-mono text-caption uppercase tracking-wide text-muted-foreground/80">
                section {sectionIndex + 1}
              </span>
              <span className="text-lead font-medium">{section.title}</span>
            </h2>
            {flat
              .filter((entry) => entry.sectionIndex === sectionIndex)
              .map((entry) => (
                <QuestionCard
                  key={entry.question.id}
                  entry={entry}
                  answer={answers[entry.question.id] ?? ''}
                  flagged={flags.has(entry.question.id)}
                  locked={expired}
                  onAnswer={(value) => setAnswer(entry.question.id, value)}
                  onToggleFlag={() => toggleFlag(entry.question.id)}
                />
              ))}
          </section>
        ))}

        <footer className="flex items-center justify-between gap-4 border-t pt-6 pb-4">
          <span className="font-mono text-caption text-muted-foreground">
            {unanswered > 0 ? (
              <>
                <span className="numeric">{unanswered}</span> unanswered — they score zero at the
                deadline
              </>
            ) : (
              'every question answered'
            )}
          </span>
          <Button onClick={() => setConfirmOpen(true)} disabled={expired || submitting}>
            Submit exam
          </Button>
        </footer>
      </main>

      {confirmOpen && !expired ? (
        <SubmitDialog
          unanswered={unanswered}
          total={flat.length}
          submitting={submitting}
          submitError={submitError}
          onConfirm={() => void submit()}
          onCancel={() => setConfirmOpen(false)}
        />
      ) : null}
      {expired ? <ExpiredOverlay /> : null}
    </div>
  );
}
