'use client';

import { useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Loader2, Play } from 'lucide-react';
import type { ExamDto } from '@eduagent/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { startExam } from '@/lib/api';
import { flattenQuestions, totalPoints } from '@/lib/exam';

/**
 * The ready beat between generation and the sitting: question/section counts
 * (never the questions themselves — the clock hasn't started), and the start
 * button that stamps the server-authoritative deadline (plans/03 §3.5).
 */
export function ExamReady({ exam, onStarted }: { exam: ExamDto; onStarted: () => void }) {
  const reducedMotion = useReducedMotion();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const questions = exam.questions;
  if (!questions) return null;
  const count = flattenQuestions(questions).length;
  const points = totalPoints(questions);

  const start = async () => {
    setStarting(true);
    setStartError(null);
    try {
      await startExam(exam.id);
      onStarted();
    } catch (err) {
      setStarting(false);
      setStartError(err instanceof Error ? err.message : 'Starting the exam failed.');
    }
  };

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <motion.section
        initial={reducedMotion ? false : { opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        aria-label="Exam ready"
        className="flex w-full max-w-lg flex-col gap-5 rounded-lg border bg-surface p-8"
      >
        <div className="flex items-center gap-3">
          <Badge variant="accent" className="font-mono lowercase">
            ready
          </Badge>
          <span className="font-mono text-caption text-muted-foreground">
            mock exam · {exam.trackSlug}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="font-display text-h2 font-medium">Your exam is ready.</h2>
          <p className="font-mono text-body-sm text-muted-foreground">
            <span className="numeric text-foreground">{count}</span> questions ·{' '}
            <span className="numeric text-foreground">{questions.sections.length}</span> sections ·{' '}
            <span className="numeric text-foreground">{points}</span> pts ·{' '}
            <span className="numeric text-foreground">{exam.durationMin}</span> minutes
          </p>
        </div>

        <ul className="flex flex-col gap-1.5">
          {questions.sections.map((section, index) => (
            <li
              key={index}
              className="flex items-center gap-3 rounded-md bg-surface-2/60 px-3 py-2 font-mono text-caption"
            >
              <span className="text-muted-foreground">{String(index + 1).padStart(2, '0')}</span>
              <span className="min-w-0 flex-1 truncate">{section.title}</span>
              <span className="numeric text-muted-foreground">
                {section.questions.length} q ·{' '}
                {section.questions.reduce((sum, q) => sum + q.points, 0)} pts
              </span>
            </li>
          ))}
        </ul>

        <p className="text-body-sm text-muted-foreground">
          Start when you&apos;re ready. The clock is the server&apos;s, it doesn&apos;t pause, and
          when it runs out your saved answers are submitted for you.
        </p>

        <Button size="lg" className="gap-2" disabled={starting} onClick={() => void start()}>
          {starting ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Play className="size-4" aria-hidden />
          )}
          {starting ? 'Starting the clock…' : 'Start the exam'}
        </Button>
        {startError ? (
          <p role="alert" className="text-body-sm text-danger">
            {startError}
          </p>
        ) : null}
      </motion.section>
    </div>
  );
}
