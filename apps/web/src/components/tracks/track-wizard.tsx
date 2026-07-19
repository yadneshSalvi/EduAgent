'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { motion, useReducedMotion } from 'motion/react';
import { CalendarDays, Check, FileText, Loader2, Plus, X } from 'lucide-react';
import type { TrackIntake } from '@eduagent/shared';
import { createTrack } from '@/lib/api';
import { useTracks } from '@/hooks/use-tracks';
import {
  parseTrackWizardState,
  schedulePreview,
  type LevelChoice,
  type StudyDay,
  type TrackWizardState,
} from '@/lib/track-wizard';
import { WizardChrome } from '@/components/onboarding/onboarding-wizard';
import { NumberTicker } from '@/components/shared/number-ticker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { GenerationScene } from './generation-scene';
import { cn } from '@/lib/utils';

const STEPS = ['Goal', 'Scope', 'Schedule', 'You'];
const GOALS: Array<{ label: string; value: TrackIntake['goalType'] }> = [
  { label: 'Interview', value: 'interview' },
  { label: 'Exam', value: 'exam' },
  { label: 'Skill', value: 'mastery' },
  { label: 'Curiosity', value: 'explore' },
];
const SUGGESTIONS = [
  'Foundations',
  'Core concepts',
  'Practical exercises',
  'Common patterns',
  'Debugging',
  'Interview practice',
];
const WEEKDAYS: Array<{ short: string; value: StudyDay }> = [
  { short: 'Mon', value: 'mon' },
  { short: 'Tue', value: 'tue' },
  { short: 'Wed', value: 'wed' },
  { short: 'Thu', value: 'thu' },
  { short: 'Fri', value: 'fri' },
  { short: 'Sat', value: 'sat' },
  { short: 'Sun', value: 'sun' },
];
const LEVELS: Array<{ label: string; value: LevelChoice }> = [
  { label: 'New to this', value: 'new' },
  { label: 'Rusty', value: 'rusty' },
  { label: 'Comfortable', value: 'comfortable' },
  { label: 'Sharp', value: 'sharp' },
];
const STYLES: Array<{ label: string; value: NonNullable<TrackIntake['style']> }> = [
  { label: 'Explain first', value: 'explain-first' },
  { label: 'Drill first', value: 'drill-first' },
  { label: 'Mix it up', value: 'mix' },
];

const INITIAL_STATE: TrackWizardState = {
  subject: '',
  goalType: null,
  targetDate: '',
  sourceText: '',
  subtopics: [],
  totalDays: 10,
  studyDays: ['mon', 'tue', 'wed', 'thu', 'fri'],
  minutesPerDay: 30,
  level: 'new',
  style: undefined,
  priorKnowledge: '',
};

function ChoiceCard({
  selected,
  children,
  onClick,
}: {
  selected: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className="text-left">
      <Card
        className={cn(
          'h-full min-h-20 justify-center p-4 transition-colors duration-150 hover:border-primary/50',
          selected && 'border-primary/50 bg-accent-soft',
        )}
      >
        <span className="flex items-center justify-between gap-3 font-medium">
          {children}
          {selected ? <Check className="size-4 text-primary" aria-hidden /> : null}
        </span>
      </Card>
    </button>
  );
}

function GhostSkip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      className="self-start text-muted-foreground"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

export function TrackWizard() {
  const reducedMotion = useReducedMotion();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<TrackWizardState>(INITIAL_STATE);
  const [chipDraft, setChipDraft] = useState('');
  const [fileWarning, setFileWarning] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<{ slug: string; planThreadId: string } | null>(null);
  const [customDuration, setCustomDuration] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  // A reload mid-generation lands back here with a blank wizard (QA F4) —
  // surface the in-flight track so the learner can resume its scene.
  const tracksQuery = useTracks();
  const generatingTrack = tracksQuery.data?.find((track) => track.status === 'generating') ?? null;

  const sourceBranch = state.goalType === 'interview' || state.goalType === 'exam';
  const preview = useMemo(
    () =>
      schedulePreview({
        totalDays: state.totalDays,
        studyDays: state.studyDays,
        targetDate: sourceBranch ? state.targetDate : '',
      }),
    [sourceBranch, state.studyDays, state.targetDate, state.totalDays],
  );
  const finish = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
    preview.finishDate,
  );

  const addSubtopic = useCallback((raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setState((current) =>
      current.subtopics.some((item) => item.toLowerCase() === value.toLowerCase())
        ? current
        : { ...current, subtopics: [...current.subtopics, value] },
    );
    setChipDraft('');
  }, []);

  const readFile = useCallback(async (file: File) => {
    if (!/\.(txt|md)$/i.test(file.name)) {
      setFileWarning('Choose a .txt or .md file.');
      return;
    }
    const text = await file.text();
    const capped = text.slice(0, 30_000);
    setState((current) => ({ ...current, sourceText: capped }));
    setFileWarning(
      text.length > 30_000
        ? 'This file was longer than 30,000 characters, so only the first 30,000 were added.'
        : null,
    );
  }, []);

  const advance = useCallback(() => {
    setError(null);
    if (step === 0 && state.subject.trim() === '') {
      setError('Tell the agent what you want to learn.');
      return;
    }
    if (step < STEPS.length - 1) {
      setStep((current) => current + 1);
      return;
    }
    const parsed = parseTrackWizardState(state);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the track details and try again.');
      return;
    }
    setSubmitting(true);
    createTrack(parsed.data)
      .then((result) =>
        setGenerated({ slug: result.track.slug, planThreadId: result.planThreadId }),
      )
      .catch((caught: unknown) => {
        setSubmitting(false);
        setError(caught instanceof Error ? caught.message : 'The roadmap draft could not start.');
      });
  }, [state, step]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        advance();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [advance]);

  if (generated) {
    return (
      <GenerationScene slug={generated.slug} planThreadId={generated.planThreadId} fullScreen />
    );
  }

  return (
    <WizardChrome
      step={step}
      steps={STEPS}
      headerLinkHref="/app"
      headerLinkLabel="Back to tracks →"
    >
      <form
        className="flex min-h-0 flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          advance();
        }}
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-10">
          {generatingTrack ? (
            <div className="mx-auto mb-6 w-full max-w-3xl">
              <Card className="flex-row items-center gap-3 border-primary/40 p-4">
                <span className="chip-dots text-primary" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
                <p className="min-w-0 flex-1 text-body-sm">
                  A roadmap is being drafted for{' '}
                  <span className="font-medium">{generatingTrack.title}</span>.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/app/tracks/${generatingTrack.slug}`}>Watch it live</Link>
                </Button>
              </Card>
            </div>
          ) : null}
          <motion.div
            key={step}
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
            className="mx-auto flex w-full max-w-3xl flex-col gap-7"
          >
            {step === 0 ? (
              <>
                <div className="flex flex-col gap-2">
                  <h1 className="font-display text-h1 font-medium">What are you learning?</h1>
                  <input
                    autoFocus
                    value={state.subject}
                    onChange={(event) =>
                      setState((current) => ({ ...current, subject: event.target.value }))
                    }
                    placeholder="e.g. SQL for backend interviews"
                    aria-label="Track subject"
                    className="min-h-16 border-0 border-b bg-transparent font-display text-h2 italic outline-none placeholder:text-muted-foreground"
                  />
                </div>
                <fieldset className="flex flex-col gap-3">
                  <legend className="text-lead font-medium">
                    Is there something you&apos;re aiming at?
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {GOALS.map((goal) => (
                      <ChoiceCard
                        key={goal.value}
                        selected={state.goalType === goal.value}
                        onClick={() =>
                          setState((current) => ({
                            ...current,
                            goalType: goal.value,
                            targetDate:
                              goal.value === 'interview' || goal.value === 'exam'
                                ? current.targetDate
                                : '',
                          }))
                        }
                      >
                        {goal.label}
                      </ChoiceCard>
                    ))}
                  </div>
                </fieldset>
                {sourceBranch ? (
                  <div className="flex flex-col gap-2">
                    <label htmlFor="track-target-date" className="text-body-sm font-medium">
                      When is it? — optional
                    </label>
                    <input
                      id="track-target-date"
                      type="date"
                      value={state.targetDate}
                      onChange={(event) =>
                        setState((current) => ({ ...current, targetDate: event.target.value }))
                      }
                      className="h-10 w-fit rounded-md border bg-surface px-3 text-body-sm"
                    />
                    <GhostSkip
                      onClick={() => setState((current) => ({ ...current, targetDate: '' }))}
                    >
                      Skip — agent decides
                    </GhostSkip>
                  </div>
                ) : null}
              </>
            ) : null}

            {step === 1 ? (
              <>
                <div className="flex flex-col gap-2">
                  <h1 className="font-display text-h1 font-medium">What should it cover?</h1>
                  <p className="text-body-sm text-muted-foreground">
                    {sourceBranch
                      ? 'Paste the syllabus or job description — the agent reads it like a person would. Paste anything.'
                      : 'Add any subtopics you already know belong in the roadmap.'}
                  </p>
                </div>
                {sourceBranch ? (
                  <>
                    <textarea
                      value={state.sourceText}
                      onChange={(event) => {
                        const raw = event.target.value;
                        setState((current) => ({ ...current, sourceText: raw.slice(0, 30_000) }));
                        setFileWarning(
                          raw.length > 30_000 ? 'The 30,000 character limit is in place.' : null,
                        );
                      }}
                      placeholder="Paste anything."
                      className="min-h-48 resize-y rounded-lg border bg-surface p-4 font-mono text-body-sm outline-none focus:border-primary/50"
                    />
                    <button
                      type="button"
                      onClick={() => fileInput.current?.click()}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => {
                        event.preventDefault();
                        const file = event.dataTransfer.files[0];
                        if (file) void readFile(file);
                      }}
                      className="flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-body-sm text-muted-foreground transition-colors duration-150 hover:border-primary/50 hover:text-foreground"
                    >
                      <FileText className="size-5" aria-hidden />
                      Drop a .txt or .md file, or choose one
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept=".txt,.md,text/plain,text/markdown"
                      className="sr-only"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void readFile(file);
                      }}
                    />
                    {fileWarning ? <p className="text-caption text-warn">{fileWarning}</p> : null}
                    <p className="font-mono text-caption text-muted-foreground">
                      Source text is kept with this track in your versioned memory.
                    </p>
                    <GhostSkip
                      onClick={() => setState((current) => ({ ...current, sourceText: '' }))}
                    >
                      Skip — agent decides
                    </GhostSkip>
                  </>
                ) : (
                  <>
                    <div className="flex flex-wrap gap-2">
                      {state.subtopics.map((subtopic) => (
                        <Badge key={subtopic} variant="secondary" className="gap-1">
                          {subtopic}
                          <button
                            type="button"
                            aria-label={`Remove ${subtopic}`}
                            onClick={() =>
                              setState((current) => ({
                                ...current,
                                subtopics: current.subtopics.filter((item) => item !== subtopic),
                              }))
                            }
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </Badge>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input
                        value={chipDraft}
                        onChange={(event) => setChipDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
                            event.preventDefault();
                            addSubtopic(chipDraft);
                          }
                        }}
                        placeholder="Type a subtopic and press Enter"
                        className="h-10 min-w-0 flex-1 rounded-md border bg-surface px-3 text-body-sm outline-none focus:border-primary/50"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => addSubtopic(chipDraft)}
                      >
                        <Plus className="size-4" aria-hidden />
                        Add
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {SUGGESTIONS.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => addSubtopic(suggestion)}
                          className="rounded-sm border px-2.5 py-1 text-caption text-muted-foreground transition-colors duration-150 hover:border-primary/50 hover:text-foreground"
                        >
                          + {suggestion}
                        </button>
                      ))}
                    </div>
                    <GhostSkip
                      onClick={() => setState((current) => ({ ...current, subtopics: [] }))}
                    >
                      Skip — agent decides
                    </GhostSkip>
                  </>
                )}
              </>
            ) : null}

            {step === 2 ? (
              <>
                <div className="flex flex-col gap-2">
                  <h1 className="font-display text-h1 font-medium">How do you want to pace it?</h1>
                  <p className="text-body-sm text-muted-foreground">
                    Dates are pencil, not pen — the plan paces to your progress, never the other way
                    around.
                  </p>
                </div>
                <Card className="gap-7">
                  <fieldset className="flex flex-col gap-3">
                    <legend className="mb-3 text-body-sm font-medium">Duration</legend>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['1 week', 5],
                        ['2 weeks', 10],
                        ['3 weeks', 15],
                        ['1 month', 22],
                      ].map(([label, days]) => (
                        <Button
                          key={label}
                          type="button"
                          variant={
                            !customDuration && state.totalDays === days ? 'secondary' : 'outline'
                          }
                          onClick={() => {
                            setCustomDuration(false);
                            setState((current) => ({ ...current, totalDays: Number(days) }));
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                      <Button
                        type="button"
                        variant={customDuration ? 'secondary' : 'outline'}
                        onClick={() => {
                          setCustomDuration(true);
                          setState((current) => ({ ...current, totalDays: 30 }));
                        }}
                      >
                        custom
                      </Button>
                    </div>
                    {customDuration ? (
                      <label className="flex max-w-xs items-center gap-3 font-mono text-caption text-muted-foreground">
                        study days
                        <input
                          type="number"
                          min={5}
                          max={60}
                          value={state.totalDays}
                          onChange={(event) =>
                            setState((current) => ({
                              ...current,
                              totalDays: Math.min(60, Math.max(5, Number(event.target.value) || 5)),
                            }))
                          }
                          className="h-10 w-24 rounded-md border bg-background px-3 text-foreground"
                        />
                      </label>
                    ) : null}
                  </fieldset>
                  <fieldset className="flex flex-col gap-3">
                    <legend className="mb-3 text-body-sm font-medium">Study weekdays</legend>
                    <div className="flex flex-wrap gap-2">
                      {WEEKDAYS.map((day) => {
                        const selected = state.studyDays.includes(day.value);
                        return (
                          <button
                            key={day.value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() =>
                              setState((current) => {
                                const next = selected
                                  ? current.studyDays.filter((value) => value !== day.value)
                                  : [...current.studyDays, day.value];
                                return next.length > 0 ? { ...current, studyDays: next } : current;
                              })
                            }
                            className={cn(
                              'flex size-10 items-center justify-center rounded-md border font-mono text-caption transition-colors duration-150',
                              selected
                                ? 'border-primary/50 bg-accent-soft text-primary-legible'
                                : 'text-muted-foreground hover:border-primary/50',
                            )}
                          >
                            {day.short}
                          </button>
                        );
                      })}
                    </div>
                  </fieldset>
                  <fieldset className="flex flex-col gap-3">
                    <legend className="mb-3 text-body-sm font-medium">Session length</legend>
                    <div className="flex flex-wrap rounded-md border p-1">
                      {[15, 30, 45, 60, 90].map((minutes) => (
                        <button
                          key={minutes}
                          type="button"
                          aria-pressed={state.minutesPerDay === minutes}
                          onClick={() =>
                            setState((current) => ({ ...current, minutesPerDay: minutes }))
                          }
                          className={cn(
                            'h-10 rounded-sm px-3 font-mono text-caption transition-colors duration-150',
                            state.minutesPerDay === minutes
                              ? 'bg-accent-soft text-primary-legible'
                              : 'text-muted-foreground hover:bg-surface-2',
                          )}
                        >
                          {minutes} min
                        </button>
                      ))}
                    </div>
                  </fieldset>
                  <p className="flex items-center gap-2 rounded-md bg-surface-2 px-4 py-3 font-mono text-body-sm text-muted-foreground">
                    <CalendarDays className="size-4 text-primary" aria-hidden />
                    ≈ <NumberTicker value={preview.studyDays} decimals={0} /> study days · finishing
                    around {finish}
                  </p>
                </Card>
              </>
            ) : null}

            {step === 3 ? (
              <>
                <div className="flex flex-col gap-2">
                  <h1 className="font-display text-h1 font-medium">A little about you</h1>
                  <p className="text-body-sm text-muted-foreground">
                    Everything here is optional. The tutor can learn it with you.
                  </p>
                </div>
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-3 text-body-sm font-medium">Current level</legend>
                  <div className="flex flex-wrap rounded-md border p-1">
                    {LEVELS.map((level) => (
                      <button
                        key={level.value}
                        type="button"
                        onClick={() => setState((current) => ({ ...current, level: level.value }))}
                        className={cn(
                          'h-10 rounded-sm px-3 text-body-sm transition-colors duration-150',
                          state.level === level.value
                            ? 'bg-accent-soft text-primary-legible'
                            : 'text-muted-foreground hover:bg-surface-2',
                        )}
                      >
                        {level.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                <fieldset className="flex flex-col gap-3">
                  <legend className="mb-3 text-body-sm font-medium">
                    How should the tutor start?
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-3">
                    {STYLES.map((style) => (
                      <ChoiceCard
                        key={style.value}
                        selected={state.style === style.value}
                        onClick={() => setState((current) => ({ ...current, style: style.value }))}
                      >
                        {style.label}
                      </ChoiceCard>
                    ))}
                  </div>
                </fieldset>
                <textarea
                  value={state.priorKnowledge}
                  onChange={(event) =>
                    setState((current) => ({ ...current, priorKnowledge: event.target.value }))
                  }
                  placeholder="Anything the tutor should know? What you've tried, what's felt hard."
                  className="min-h-32 resize-y rounded-lg border bg-surface p-4 text-body-sm outline-none focus:border-primary/50"
                />
                <GhostSkip
                  onClick={() =>
                    setState((current) => ({
                      ...current,
                      level: 'new',
                      style: undefined,
                      priorKnowledge: '',
                    }))
                  }
                >
                  Skip — agent decides
                </GhostSkip>
              </>
            ) : null}

            {error ? (
              <p role="alert" className="text-body-sm text-danger">
                {error}
              </p>
            ) : null}
          </motion.div>
        </div>

        <footer className="flex h-20 shrink-0 items-center justify-between gap-4 border-t px-6 sm:px-10">
          <Button
            type="button"
            variant="link"
            disabled={step === 0 || submitting}
            onClick={() => {
              setError(null);
              setStep((current) => Math.max(0, current - 1));
            }}
          >
            Back
          </Button>
          <div className="flex items-center gap-3">
            <span className="hidden font-mono text-caption text-muted-foreground sm:inline">
              ⌘ Enter
            </span>
            <Button type="submit" disabled={submitting}>
              {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
              {step === STEPS.length - 1 ? 'Draft my roadmap' : 'Continue'}
            </Button>
          </div>
        </footer>
      </form>
    </WizardChrome>
  );
}
