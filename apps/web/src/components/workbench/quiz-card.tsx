'use client';

import { useId } from 'react';
import { Check, X } from 'lucide-react';
import type { QuizQuestion } from '@eduagent/shared';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/chat/markdown';
import { checkAnswer, type ClientVerdict } from '@/lib/workbench';
import { cn } from '@/lib/utils';

/**
 * One quiz question (plans/04 §3): mcq and predict_output check instantly
 * client-side (the answer key ships in the payload — accepted contract
 * decision), short answers queue for the agent. Composable: also used by the
 * review flow and onboarding baseline (card form) later.
 */
export interface QuizResponse {
  answer: string;
  /** null until checked (or for short answers, always null — agent-graded). */
  verdict: ClientVerdict | null;
  /** mcq/predict_output: the instant check happened; short: answer confirmed. */
  checked: boolean;
}

export const EMPTY_RESPONSE: QuizResponse = { answer: '', verdict: null, checked: false };

interface QuizCardProps {
  question: QuizQuestion;
  response: QuizResponse;
  onRespond: (response: QuizResponse) => void;
  disabled?: boolean;
}

export function QuizCard({ question, response, onRespond, disabled }: QuizCardProps) {
  return (
    <div className="flex flex-col gap-4">
      <Markdown content={question.prompt_md} className="text-body-sm" />
      {question.type === 'mcq' ? (
        <McqOptions
          question={question}
          response={response}
          onRespond={onRespond}
          disabled={disabled}
        />
      ) : question.type === 'predict_output' ? (
        <PredictOutput
          question={question}
          response={response}
          onRespond={onRespond}
          disabled={disabled}
        />
      ) : (
        <ShortAnswer response={response} onRespond={onRespond} disabled={disabled} />
      )}
    </div>
  );
}

function McqOptions({
  question,
  response,
  onRespond,
  disabled,
}: QuizCardProps & { disabled?: boolean }) {
  const settled = response.checked || disabled;
  return (
    <div role="radiogroup" aria-label="Answer options" className="flex flex-col gap-2">
      {(question.options ?? []).map((option) => {
        const isPicked = response.answer === option;
        const isKey = question.answer !== undefined && option.trim() === question.answer.trim();
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={isPicked}
            disabled={settled}
            onClick={() =>
              onRespond({ answer: option, verdict: checkAnswer(question, option), checked: true })
            }
            className={cn(
              'flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-body-sm transition-colors duration-150',
              !settled && 'hover:border-primary/50 hover:bg-surface-2',
              settled && 'cursor-default',
              // After the check the key is revealed (it shipped with the payload).
              response.checked && isKey && 'border-success/60 bg-success/10',
              response.checked && isPicked && !isKey && 'border-danger/60 bg-danger/10',
              !response.checked && isPicked && 'border-primary',
            )}
          >
            <span className="min-w-0 flex-1">{option}</span>
            {response.checked && isKey ? (
              <Check className="size-4 shrink-0 text-success" aria-hidden />
            ) : null}
            {response.checked && isPicked && !isKey ? (
              <X className="size-4 shrink-0 text-danger" aria-hidden />
            ) : null}
          </button>
        );
      })}
      {response.checked ? <InstantVerdict verdict={response.verdict} /> : null}
    </div>
  );
}

function PredictOutput({
  question,
  response,
  onRespond,
  disabled,
}: QuizCardProps & { disabled?: boolean }) {
  const inputId = useId();
  const settled = response.checked || disabled;
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={inputId} className="font-mono text-caption text-muted-foreground">
        your predicted output
      </label>
      <textarea
        id={inputId}
        rows={2}
        value={response.answer}
        disabled={settled}
        onChange={(event) =>
          onRespond({ answer: event.target.value, verdict: null, checked: false })
        }
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !settled) {
            event.preventDefault();
            if (response.answer.trim() !== '') {
              onRespond({
                ...response,
                verdict: checkAnswer(question, response.answer),
                checked: true,
              });
            }
          }
        }}
        className="w-full resize-none rounded-md border bg-background px-3 py-2 font-mono text-body-sm outline-none transition-colors duration-150 focus:border-ring disabled:opacity-70"
      />
      {!response.checked ? (
        <Button
          size="sm"
          variant="outline"
          disabled={settled || response.answer.trim() === ''}
          onClick={() =>
            onRespond({
              ...response,
              verdict: checkAnswer(question, response.answer),
              checked: true,
            })
          }
          className="self-start"
        >
          Check my prediction
        </Button>
      ) : (
        <>
          <InstantVerdict verdict={response.verdict} />
          {response.verdict === 'incorrect' && question.answer ? (
            <p className="font-mono text-caption text-muted-foreground">
              expected: <span className="text-foreground">{question.answer}</span>
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function ShortAnswer({
  response,
  onRespond,
  disabled,
}: {
  response: QuizResponse;
  onRespond: (response: QuizResponse) => void;
  disabled?: boolean;
}) {
  const inputId = useId();
  return (
    <div className="flex flex-col gap-2.5">
      <label htmlFor={inputId} className="font-mono text-caption text-muted-foreground">
        your answer — the tutor grades this when you finish
      </label>
      <textarea
        id={inputId}
        rows={3}
        value={response.answer}
        disabled={disabled}
        onChange={(event) =>
          onRespond({ answer: event.target.value, verdict: null, checked: false })
        }
        className="w-full resize-none rounded-md border bg-background px-3 py-2 text-body-sm outline-none transition-colors duration-150 focus:border-ring disabled:opacity-70"
      />
    </div>
  );
}

function InstantVerdict({ verdict }: { verdict: ClientVerdict | null }) {
  if (!verdict) return null;
  const correct = verdict === 'correct';
  return (
    <p
      role="status"
      className={cn(
        'flex items-center gap-1.5 text-body-sm font-medium',
        correct ? 'text-success' : 'text-danger',
      )}
    >
      {correct ? <Check className="size-4" aria-hidden /> : <X className="size-4" aria-hidden />}
      {correct ? 'Correct.' : 'Not quite.'}
    </p>
  );
}
