'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { motion, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  FileDiff,
  GitCommitHorizontal,
  Loader2,
  MinusCircle,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ExamDto, ExamResult } from '@eduagent/shared';
import { Markdown } from '@/components/chat/markdown';
import { GaugeDial } from '@/components/dashboard/readiness-gauge';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';
import { EMPTY_TREE_SHA } from '@/components/dashboard/timeline-feed';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTickedNumber } from '@/components/shared/number-ticker';
import { getMemoryDiff, getMemoryLog } from '@/lib/api';
import {
  buildConceptResults,
  buildQuestionResults,
  clearExamLocal,
  conceptOutcome,
  findExamCommitIndex,
  readinessSweep,
  totalPoints,
  type ConceptResult,
  type QuestionResultView,
} from '@/lib/exam';
import { MONACO_FONT_FAMILY, defineEduAgentTheme } from '@/lib/monaco-theme';
import { monacoLanguage } from '@/lib/workbench';
import { cn } from '@/lib/utils';

/**
 * Exam results (plans/04 §6): score hero with the readiness gauge sweeping
 * before → after (the view's one hero animation), per-question accordion with
 * the examiner's feedback, per-concept breakdown, and the bridge back to the
 * product thesis — the diff this exam committed to your memory.
 */

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-surface font-mono text-caption text-muted-foreground">
      loading editor…
    </div>
  ),
});

type Verdict = ExamResult['per_question'][number]['verdict'];

const VERDICT_META: Record<
  Verdict,
  { icon: LucideIcon; label: string; className: string; badge: 'success' | 'warn' | 'destructive' }
> = {
  correct: { icon: CheckCircle2, label: 'correct', className: 'text-success', badge: 'success' },
  partial: { icon: MinusCircle, label: 'partial', className: 'text-warn', badge: 'warn' },
  incorrect: { icon: XCircle, label: 'incorrect', className: 'text-danger', badge: 'destructive' },
};

const OUTCOME_META: Record<
  ReturnType<typeof conceptOutcome>,
  { label: string; className: string }
> = {
  held: { label: 'held', className: 'border-success/40 bg-success/10 text-success' },
  mixed: { label: 'mixed', className: 'border-warn/40 bg-warn/10 text-warn' },
  slipped: { label: 'slipped', className: 'border-danger/40 bg-danger/10 text-danger' },
};

function formatPoints(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function ScoreHero({ exam, result }: { exam: ExamDto; result: ExamResult }) {
  const reducedMotion = useReducedMotion();
  const max = exam.questions ? totalPoints(exam.questions) : 0;
  const sweep = readinessSweep(result);
  const ticked = useTickedNumber(result.total, { from: 0, durationMs: 900 });
  const deltaUp = sweep.delta >= 0;

  const counts = { correct: 0, partial: 0, incorrect: 0 };
  for (const grade of result.per_question) counts[grade.verdict] += 1;

  return (
    <motion.section
      initial={reducedMotion ? false : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ type: 'spring', stiffness: 280, damping: 30 }}
      aria-label="Exam score"
      className="grid items-center gap-8 rounded-lg border bg-surface p-8 md:grid-cols-[1fr_auto]"
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="success" className="font-mono lowercase">
            graded
          </Badge>
          <span className="font-mono text-caption text-muted-foreground">
            mock exam · {exam.trackSlug} · <span className="numeric">{exam.durationMin}</span>m
          </span>
        </div>
        <p className="font-display text-display font-medium leading-none">
          <span className="numeric">{formatPoints(Math.round(ticked * 10) / 10)}</span>
          <span className="text-h3 text-muted-foreground"> / {formatPoints(max)} pts</span>
        </p>
        <div className="flex flex-wrap items-center gap-4 font-mono text-caption">
          {(Object.keys(VERDICT_META) as Verdict[]).map((verdict) => {
            const meta = VERDICT_META[verdict];
            const Icon = meta.icon;
            const count = counts[verdict];
            if (count === 0) return null;
            return (
              <span key={verdict} className={cn('flex items-center gap-1', meta.className)}>
                <Icon className="size-3.5" aria-hidden />
                <span className="numeric">{count}</span> {meta.label}
              </span>
            );
          })}
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium',
              deltaUp ? 'bg-success/15 text-success' : 'bg-warn/15 text-warn',
            )}
          >
            readiness <span className="numeric">{deltaUp ? '+' : '−'}{Math.abs(sweep.delta).toFixed(1)}</span>
          </span>
        </div>
      </div>

      {sweep.after !== null ? (
        <div className="flex flex-col items-center gap-1.5 justify-self-center">
          {/* The one hero animation on this view: the gauge sweeps before → after. */}
          <GaugeDial score={sweep.after} from={sweep.before ?? 0} />
          <p className="font-mono text-caption text-muted-foreground">
            readiness <span className="numeric">{(sweep.before ?? 0).toFixed(1)}</span> →{' '}
            <span className="numeric text-foreground">{sweep.after.toFixed(1)}</span>
          </p>
        </div>
      ) : null}
    </motion.section>
  );
}

export function ConceptBreakdown({ concepts }: { concepts: ConceptResult[] }) {
  if (concepts.length === 0) return null;
  const slipped = concepts.filter((entry) => conceptOutcome(entry) !== 'held').length;
  return (
    <section aria-label="Per-concept breakdown" className="flex flex-col gap-3">
      <h2 className="text-lead font-medium">By concept</h2>
      <div className="flex flex-wrap gap-2">
        {concepts.map((entry) => {
          const outcome = OUTCOME_META[conceptOutcome(entry)];
          return (
            <span
              key={entry.concept}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-mono text-caption',
                outcome.className,
              )}
            >
              {entry.concept}
              <span className="numeric">
                {formatPoints(entry.pointsAwarded)}/{formatPoints(entry.points)} pts
              </span>
              <span className="opacity-80">{outcome.label}</span>
            </span>
          );
        })}
      </div>
      {slipped > 0 ? (
        <p className="text-caption text-muted-foreground">
          Slipped concepts are already queued for review — the examiner committed that to your
          memory.
        </p>
      ) : (
        <p className="text-caption text-muted-foreground">
          Every tested concept held. The examiner committed the evidence to your memory.
        </p>
      )}
    </section>
  );
}

function AnswerBlock({ view }: { view: QuestionResultView }) {
  const { question } = view;
  if (view.answer.trim() === '') {
    return (
      <p className="rounded-md border border-dashed px-3 py-2 font-mono text-caption text-muted-foreground">
        no answer — scored zero
      </p>
    );
  }
  if (question.type === 'coding') {
    const lineCount = view.answer.split('\n').length;
    return (
      <div
        className="overflow-hidden rounded-md border"
        style={{ height: Math.min(320, Math.max(120, lineCount * 20 + 24)) }}
      >
        <MonacoEditor
          language={monacoLanguage(question.language ?? 'plaintext')}
          value={view.answer}
          theme="eduagent-dark"
          beforeMount={defineEduAgentTheme}
          onMount={(editor) => {
            editor.getContribution('editor.contrib.readOnlyMessageController')?.dispose();
          }}
          height="100%"
          options={{
            readOnly: true,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
            fontSize: 13,
            fontFamily: MONACO_FONT_FAMILY,
            padding: { top: 10, bottom: 10 },
            lineNumbers: 'on',
            folding: false,
            renderLineHighlight: 'none',
            scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
            overviewRulerLanes: 0,
            contextmenu: false,
          }}
        />
      </div>
    );
  }
  return (
    <p className="whitespace-pre-wrap rounded-md bg-surface-2/60 px-3 py-2 text-body-sm">
      {view.answer}
    </p>
  );
}

export function QuestionReview({ view }: { view: QuestionResultView }) {
  const [expanded, setExpanded] = useState(false);
  const grade = view.grade;
  const meta = grade ? VERDICT_META[grade.verdict] : null;
  const Icon = meta?.icon ?? MinusCircle;

  return (
    <li className="rounded-lg border bg-surface">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full flex-wrap items-center gap-2.5 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-surface-2/50"
      >
        <Icon className={cn('size-4.5 shrink-0', meta?.className ?? 'text-muted-foreground')} aria-hidden />
        <span className="font-mono text-body-sm font-semibold">
          Q<span className="numeric">{view.number}</span>
        </span>
        {meta && grade ? (
          <Badge variant={meta.badge} className="font-mono lowercase">
            {meta.label}
          </Badge>
        ) : (
          <Badge variant="secondary" className="font-mono lowercase">
            ungraded
          </Badge>
        )}
        {view.question.concepts.map((concept) => (
          <span
            key={concept}
            className="rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
          >
            {concept}
          </span>
        ))}
        <span className="flex-1" />
        <span className="font-mono text-caption text-muted-foreground">
          <span className="numeric text-foreground">
            {formatPoints(grade?.points_awarded ?? 0)}
          </span>
          /<span className="numeric">{formatPoints(view.question.points)}</span> pts
        </span>
        <ChevronDown
          aria-hidden
          className={cn(
            'size-4 text-muted-foreground transition-transform duration-150',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded ? (
        <div className="flex flex-col gap-4 border-t px-5 py-4">
          <Markdown content={view.question.prompt_md} className="text-body-sm" />
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground/80">
              your answer
            </p>
            <AnswerBlock view={view} />
          </div>
          {grade ? (
            <div className="flex flex-col gap-1.5 border-l-2 border-primary/50 pl-4">
              <p className="font-mono text-caption uppercase tracking-wide text-muted-foreground/80">
                examiner&apos;s feedback
              </p>
              <Markdown content={grade.feedback_md} className="text-body-sm" />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

/** "See what this did to your memory" → the exam commit in the Diff Drawer. */
function MemoryCommitLink({ exam }: { exam: ExamDto }) {
  const { openDrawer } = useMemoryCommits();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const { commits } = await getMemoryLog({ limit: 50 });
      const index = findExamCommitIndex(commits, exam.submittedAt);
      const entry = index === -1 ? undefined : commits[index];
      if (!entry) {
        setError("The exam commit hasn't landed in your memory log yet — try again in a moment.");
        return;
      }
      const from = commits[index + 1]?.sha ?? EMPTY_TREE_SHA;
      const { diff, stats } = await getMemoryDiff(from, entry.sha);
      openDrawer({
        sha: entry.sha,
        type: entry.type,
        topic: entry.topic,
        headline: entry.headline,
        bullets: entry.bullets,
        deltas: entry.deltas,
        stats,
        diff,
      });
    } catch {
      setError("The diff didn't come back — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-label="Memory commit"
      className="flex flex-wrap items-center gap-4 rounded-lg border bg-surface p-6"
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-primary">
        <GitCommitHorizontal className="size-5" aria-hidden />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-body font-medium">This exam changed your memory.</p>
        <p className="text-caption text-muted-foreground">
          Grading committed mastery evidence per concept — readiness moved because the memory did.
        </p>
        {error ? <p className="text-caption text-danger">{error}</p> : null}
      </div>
      <Button variant="outline" className="gap-1.5" disabled={busy} onClick={() => void open()}>
        {busy ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <FileDiff className="size-3.5" aria-hidden />
        )}
        See what this did to your memory
      </Button>
    </section>
  );
}

export function ExamResults({ exam }: { exam: ExamDto }) {
  // The sitting is over — drop the localStorage draft.
  useEffect(() => clearExamLocal(exam.id), [exam.id]);

  const questions = exam.questions;
  const result = exam.result;
  if (!questions || !result) return null;

  const questionResults = buildQuestionResults(questions, result, exam.answers);
  const concepts = buildConceptResults(questionResults);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
      <ScoreHero exam={exam} result={result} />
      <ConceptBreakdown concepts={concepts} />

      <section aria-label="Per-question review" className="flex flex-col gap-3">
        <h2 className="text-lead font-medium">By question</h2>
        <ul className="flex flex-col gap-2">
          {questionResults.map((view) => (
            <QuestionReview key={view.question.id} view={view} />
          ))}
        </ul>
      </section>

      <MemoryCommitLink exam={exam} />

      <div className="flex flex-wrap gap-3 pb-4">
        <Button asChild className="gap-1.5">
          <Link href="/app">
            Back to dashboard
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/app/exam">Take another exam</Link>
        </Button>
      </div>
    </div>
  );
}
