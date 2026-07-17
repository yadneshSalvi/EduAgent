'use client';

import { motion, useReducedMotion } from 'motion/react';
import { CheckCircle2, MessageSquareText, RotateCcw, XCircle } from 'lucide-react';
import type { ExerciseVerdict } from '@eduagent/shared';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/chat/markdown';
import { cn } from '@/lib/utils';

/**
 * Exercise verdict (plans/04 §3). Pass: success treatment with a restrained
 * celebration — one spring pop on the icon, a soft glow that fades (05 §5:
 * one hero moment, nothing loops). Fail: verdict + the agent's short feedback;
 * the full walkthrough streams in chat, so anchor the reader there and hand
 * the editor back via "Try again".
 */
interface VerdictBannerProps {
  verdict: ExerciseVerdict;
  feedback: string;
  attempts: number;
  onTryAgain: () => void;
}

export function VerdictBanner({ verdict, feedback, attempts, onTryAgain }: VerdictBannerProps) {
  const reducedMotion = useReducedMotion();
  const passed = verdict === 'passed';

  return (
    <motion.div
      role="status"
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 10, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={
        reducedMotion ? { duration: 0.2 } : { type: 'spring', stiffness: 320, damping: 26 }
      }
      className={cn(
        'relative overflow-hidden rounded-lg border p-4',
        passed ? 'border-success/40 bg-success/10' : 'border-danger/40 bg-danger/10',
      )}
    >
      {passed && !reducedMotion ? (
        // The celebration: one soft radial glow sweeping out, then gone.
        <motion.div
          aria-hidden
          initial={{ opacity: 0.5, scale: 0.4 }}
          animate={{ opacity: 0, scale: 2.4 }}
          transition={{ duration: 0.9, ease: 'easeOut' }}
          className="pointer-events-none absolute -left-6 -top-10 size-40 rounded-full bg-success/30 blur-2xl"
        />
      ) : null}

      <div className="relative flex items-start gap-3">
        <motion.span
          initial={reducedMotion ? false : { scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ type: 'spring', stiffness: 500, damping: 20, delay: 0.1 }}
          className={cn('mt-0.5 shrink-0', passed ? 'text-success' : 'text-danger')}
        >
          {passed ? (
            <CheckCircle2 className="size-5" aria-hidden />
          ) : (
            <XCircle className="size-5" aria-hidden />
          )}
        </motion.span>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-body font-medium">
            {passed
              ? attempts > 1
                ? `Passed on attempt ${attempts} — persistence pays.`
                : 'Passed — first try.'
              : `Not yet — attempt ${attempts} failed.`}
          </p>
          {feedback ? (
            // feedback is feedback_md — render it (QA finding F3: literal
            // `**Hint:**`/backticks read as noise in the verdict).
            <Markdown content={feedback} className="text-body-sm text-muted-foreground" />
          ) : null}
          <p className="flex items-center gap-1.5 font-mono text-caption text-muted-foreground">
            <MessageSquareText className="size-3.5 shrink-0" aria-hidden />
            {passed ? 'The tutor recaps what this proved in chat.' : 'Full walkthrough in chat →'}
          </p>
        </div>

        {!passed ? (
          <Button size="sm" variant="outline" onClick={onTryAgain} className="shrink-0 gap-1.5">
            <RotateCcw className="size-3.5" aria-hidden />
            Try again
          </Button>
        ) : null}
      </div>
    </motion.div>
  );
}
