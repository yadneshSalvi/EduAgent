'use client';

import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Play } from 'lucide-react';
import type { ExercisePayload } from '@eduagent/shared';
import type { WorkbenchExerciseState } from '@/hooks/use-turn-stream';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Markdown } from '@/components/chat/markdown';
import { MONACO_FONT_FAMILY, defineEduAgentTheme } from '@/lib/monaco-theme';
import { loadExerciseCode, monacoLanguage, saveExerciseCode } from '@/lib/workbench';
import { VerdictBanner } from './verdict-banner';

/**
 * Exercise tab (plans/04 §3): Monaco on top, prompt.md + Run below. Code is
 * persisted to localStorage per exercise id on every keystroke, so a refresh
 * never loses work. ⌘↵ submits from inside the editor; grading locks the
 * editor until the verdict lands (fail → "Try again" re-enables it).
 */
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center bg-surface font-mono text-caption text-muted-foreground">
      loading editor…
    </div>
  ),
});

const DIFFICULTY_VARIANT = { easy: 'success', medium: 'warn', hard: 'destructive' } as const;

interface ExercisePanelProps {
  exercise: WorkbenchExerciseState;
  onSubmit: (code: string) => void;
  onTryAgain: () => void;
}

export function ExercisePanel({ exercise, onSubmit, onTryAgain }: ExercisePanelProps) {
  if (!exercise.payload) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="font-serif italic text-body text-muted-foreground">No exercise yet.</p>
        <p className="max-w-[36ch] text-body-sm text-muted-foreground">
          When the tutor decides you should prove something in code, the editor opens here — ask for
          an exercise any time.
        </p>
      </div>
    );
  }
  // Keyed by exercise id: a new push remounts with fresh code state.
  return (
    <ExerciseWorkspace
      key={exercise.payload.id}
      payload={exercise.payload}
      exercise={exercise}
      onSubmit={onSubmit}
      onTryAgain={onTryAgain}
    />
  );
}

function ExerciseWorkspace({
  payload,
  exercise,
  onSubmit,
  onTryAgain,
}: {
  payload: ExercisePayload;
  exercise: WorkbenchExerciseState;
  onSubmit: (code: string) => void;
  onTryAgain: () => void;
}) {
  const [code, setCode] = useState(() => loadExerciseCode(payload.id) ?? payload.starter_code);
  const grading = exercise.phase === 'grading';
  const locked = exercise.phase !== 'editing';

  // ⌘↵ inside Monaco reaches the CURRENT submit closure via a ref.
  const submitRef = useRef<() => void>(() => {});
  submitRef.current = () => {
    if (exercise.phase === 'editing' && code.trim() !== '') onSubmit(code);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-4 py-2.5">
        <h2 className="mr-1 min-w-0 flex-1 basis-full truncate text-body font-medium sm:basis-auto">
          {payload.title}
        </h2>
        <Badge variant={DIFFICULTY_VARIANT[payload.difficulty]} className="font-mono lowercase">
          {payload.difficulty}
        </Badge>
        {payload.concepts.map((concept) => (
          <Badge key={concept} variant="secondary" className="font-mono lowercase">
            {concept}
          </Badge>
        ))}
      </div>

      <div className="min-h-0 flex-1 basis-1/2">
        <MonacoEditor
          language={monacoLanguage(payload.language)}
          value={code}
          theme="eduagent-dark"
          beforeMount={defineEduAgentTheme}
          onMount={(editor, monaco) => {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
              submitRef.current(),
            );
          }}
          onChange={(next) => {
            const value = next ?? '';
            setCode(value);
            saveExerciseCode(payload.id, value);
          }}
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

      {exercise.phase === 'graded' && exercise.verdict ? (
        <div className="shrink-0 border-t p-4">
          <VerdictBanner
            verdict={exercise.verdict}
            feedback={exercise.feedback}
            attempts={exercise.attempts}
            onTryAgain={onTryAgain}
          />
        </div>
      ) : null}

      <div className="flex max-h-[45%] min-h-0 shrink-0 basis-auto flex-col gap-3 overflow-y-auto border-t p-4">
        <Markdown content={payload.prompt_md} className="text-body-sm" />

        {exercise.submitError ? (
          <p role="alert" className="text-body-sm text-danger">
            {exercise.submitError}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <span className="font-mono text-caption text-muted-foreground">
            {exercise.attempts > 0
              ? `attempt ${exercise.attempts}${grading ? ' · running hidden tests' : ''}`
              : '⌘↵ submits from the editor'}
          </span>
          <span className="flex-1" />
          <Button
            onClick={() => submitRef.current()}
            disabled={locked || code.trim() === ''}
            className="gap-1.5"
          >
            {grading ? (
              <>
                Grading
                <span className="chip-dots" aria-hidden>
                  <span />
                  <span />
                  <span />
                </span>
              </>
            ) : (
              <>
                <Play className="size-3.5" aria-hidden />
                Run my code
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
