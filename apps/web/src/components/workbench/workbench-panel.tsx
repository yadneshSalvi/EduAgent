'use client';

import { useEffect, useRef, useState } from 'react';
import { AppWindow, Code2, ListChecks, PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { SubmitQuizRequest } from '@eduagent/shared';
import type { WorkbenchClientAction, WorkbenchState, WorkbenchTab } from '@/hooks/use-turn-stream';
import { ApiError } from '@/lib/api';
import { loadWorkbenchOpen, saveWorkbenchOpen } from '@/lib/workbench';
import { cn } from '@/lib/utils';
import { ArtifactFrame } from './artifact-frame';
import { AssessmentStrip } from './assessment-strip';
import { ExercisePanel } from './exercise-panel';
import { QuizFlow } from './quiz-flow';

/**
 * The workbench pane (plans/04 §3): Exercise · Quiz · Artifact tabs beside the
 * chat (stacked under it < md). A workbench.* push slides it open and switches
 * to that tab (UI motion class via CSS width/height transition); explicit
 * collapse/expand persists per thread. All three tabs stay mounted so editor
 * code and in-progress quiz answers survive tab switches.
 */
const TABS: Array<{ tab: WorkbenchTab; label: string; icon: typeof Code2 }> = [
  { tab: 'exercise', label: 'Exercise', icon: Code2 },
  { tab: 'quiz', label: 'Quiz', icon: ListChecks },
  { tab: 'artifact', label: 'Artifact', icon: AppWindow },
];

interface WorkbenchPanelProps {
  threadId: string;
  workbench: WorkbenchState;
  dispatch: (action: WorkbenchClientAction) => void;
  /** Transport only (REST in the live room, scripted replay in the harness). */
  onSubmitExercise: (exerciseId: string, code: string) => Promise<unknown>;
  onSubmitQuiz: (quizId: string, answers: SubmitQuizRequest['answers']) => Promise<unknown>;
}

function submitErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "The submission didn't reach the tutor — try again.";
}

export function WorkbenchPanel({
  threadId,
  workbench,
  dispatch,
  onSubmitExercise,
  onSubmitQuiz,
}: WorkbenchPanelProps) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('exercise');
  const tablistRef = useRef<HTMLDivElement>(null);

  // Stored per-thread preference loads after mount (SSR-safe — no hydration
  // mismatch from reading localStorage during render).
  useEffect(() => {
    const stored = loadWorkbenchOpen(threadId);
    if (stored !== null) setOpen(stored);
  }, [threadId]);

  // Auto-open + tab switch on every workbench.* push. Deliberately does NOT
  // persist: only the learner's own toggle is a preference.
  const seenSeq = useRef(workbench.pushSeq);
  useEffect(() => {
    if (workbench.pushSeq === seenSeq.current) return;
    seenSeq.current = workbench.pushSeq;
    if (workbench.pushedTab) setActiveTab(workbench.pushedTab);
    setOpen(true);
  }, [workbench.pushSeq, workbench.pushedTab]);

  const toggle = (next: boolean, tab?: WorkbenchTab) => {
    setOpen(next);
    saveWorkbenchOpen(threadId, next);
    if (tab) setActiveTab(tab);
  };

  const submitExercise = (code: string) => {
    const exerciseId = workbench.exercise.payload?.id;
    if (!exerciseId) return;
    dispatch({ type: 'exercise-submitted' });
    Promise.resolve(onSubmitExercise(exerciseId, code)).catch((err: unknown) => {
      // 409: an earlier attempt is still being graded (03 §3) — keep the
      // grading state, the verdict is coming over WS. Not an error.
      if (err instanceof ApiError && err.code === 'grading_in_progress') {
        dispatch({ type: 'exercise-grading-in-progress' });
      } else {
        dispatch({ type: 'exercise-submit-failed', message: submitErrorMessage(err) });
      }
    });
  };

  const submitQuiz = (answers: SubmitQuizRequest['answers']) => {
    const quizId = workbench.quiz.payload?.id;
    if (!quizId) return;
    dispatch({ type: 'quiz-submitted' });
    Promise.resolve(onSubmitQuiz(quizId, answers)).catch((err: unknown) => {
      dispatch({ type: 'quiz-submit-failed', message: submitErrorMessage(err) });
    });
  };

  const hasContent: Record<WorkbenchTab, boolean> = {
    exercise: workbench.exercise.payload !== null,
    quiz: workbench.quiz.payload !== null,
    artifact: workbench.artifact !== null,
  };

  // Roving arrow keys on the tablist (05 §9 full keyboard reach).
  const onTablistKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const order = TABS.map((t) => t.tab);
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const next = order[(order.indexOf(activeTab) + delta + order.length) % order.length];
    if (!next) return;
    setActiveTab(next);
    tablistRef.current?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
  };

  return (
    <aside
      aria-label="Workbench"
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col overflow-hidden border-t bg-surface md:h-auto md:border-l md:border-t-0',
        'transition-[width,height] duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none',
        open ? 'h-[45%] md:w-[45%] md:min-w-[380px]' : 'h-11 md:w-11',
      )}
    >
      {/* Open content stays mounted while collapsed (hidden) so editor code
          and in-progress quiz answers survive a collapse/expand cycle. */}
      <div className={cn('h-full min-h-0 w-full flex-col', open ? 'flex' : 'hidden')}>
        <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Workbench tabs"
            onKeyDown={onTablistKeyDown}
            className="flex items-center gap-1"
          >
            {TABS.map(({ tab, label, icon: Icon }) => (
              <button
                key={tab}
                type="button"
                role="tab"
                data-tab={tab}
                id={`workbench-tab-${tab}`}
                aria-selected={activeTab === tab}
                aria-controls={`workbench-panel-${tab}`}
                tabIndex={activeTab === tab ? 0 : -1}
                onClick={() => setActiveTab(tab)}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm px-2.5 py-1.5 font-mono text-caption transition-colors duration-150',
                  activeTab === tab
                    ? 'bg-accent-soft text-primary'
                    : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                {label}
                {hasContent[tab] ? (
                  <span
                    aria-hidden
                    className={cn(
                      'size-1.5 rounded-full',
                      activeTab === tab ? 'bg-primary' : 'bg-primary/60',
                    )}
                  />
                ) : null}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <button
            type="button"
            aria-label="Collapse workbench"
            onClick={() => toggle(false)}
            className="rounded-sm p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
          >
            <PanelRightClose className="size-4" aria-hidden />
          </button>
        </div>

        <AssessmentStrip assessment={workbench.assessment} seq={workbench.assessmentSeq} />

        <div className="min-h-0 flex-1">
          <div
            role="tabpanel"
            id="workbench-panel-exercise"
            aria-labelledby="workbench-tab-exercise"
            hidden={activeTab !== 'exercise'}
            className="h-full"
          >
            <ExercisePanel
              exercise={workbench.exercise}
              onSubmit={submitExercise}
              onTryAgain={() => dispatch({ type: 'exercise-try-again' })}
            />
          </div>
          <div
            role="tabpanel"
            id="workbench-panel-quiz"
            aria-labelledby="workbench-tab-quiz"
            hidden={activeTab !== 'quiz'}
            className="h-full"
          >
            {workbench.quiz.payload ? (
              <QuizFlow
                key={workbench.quiz.payload.id}
                quiz={workbench.quiz.payload}
                phase={workbench.quiz.phase}
                results={workbench.quiz.results}
                submitError={workbench.quiz.submitError}
                onFinish={submitQuiz}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="font-serif italic text-body text-muted-foreground">No quiz yet.</p>
                <p className="max-w-[36ch] text-body-sm text-muted-foreground">
                  Quick checks land here mid-conversation — a few questions to see what stuck.
                </p>
              </div>
            )}
          </div>
          <div
            role="tabpanel"
            id="workbench-panel-artifact"
            aria-labelledby="workbench-tab-artifact"
            hidden={activeTab !== 'artifact'}
            className="h-full"
          >
            <ArtifactFrame artifact={workbench.artifact} />
          </div>
        </div>
      </div>

      {!open ? (
        <>
          {/* Collapsed, < md: slim horizontal strip under the chat. */}
          <button
            type="button"
            onClick={() => toggle(true)}
            aria-label="Open workbench"
            className="flex h-11 w-full items-center gap-2 px-4 text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground md:hidden"
          >
            <PanelRightOpen className="size-4 rotate-90" aria-hidden />
            <span className="font-mono text-caption tracking-wide">workbench</span>
            {(hasContent.exercise || hasContent.quiz || hasContent.artifact) && (
              <span aria-hidden className="size-1.5 rounded-full bg-primary" />
            )}
          </button>

          {/* Collapsed, md+: vertical rail with per-tab shortcuts. */}
          <div className="hidden h-full flex-col items-center gap-2 py-3 md:flex">
            <button
              type="button"
              onClick={() => toggle(true)}
              aria-label="Open workbench"
              className="rounded-sm p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
            >
              <PanelRightOpen className="size-4" aria-hidden />
            </button>
            {TABS.map(({ tab, label, icon: Icon }) => (
              <button
                key={tab}
                type="button"
                onClick={() => toggle(true, tab)}
                aria-label={`Open workbench — ${label}`}
                className="relative rounded-sm p-1.5 text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
              >
                <Icon className="size-4" aria-hidden />
                {hasContent[tab] ? (
                  <span
                    aria-hidden
                    className="absolute right-0.5 top-0.5 size-1.5 rounded-full bg-primary"
                  />
                ) : null}
              </button>
            ))}
            <span
              className="mt-2 font-mono text-caption tracking-wide text-muted-foreground/70"
              style={{ writingMode: 'vertical-rl' }}
            >
              workbench
            </span>
          </div>
        </>
      ) : null}
    </aside>
  );
}
