'use client';

import { useRef } from 'react';
import { useReplayTurnStream } from '@/hooks/use-replay-turn-stream';
import {
  GREETING_COMMIT,
  artifactTurnScript,
  errorTurnScript,
  exerciseFailTurnScript,
  exercisePassTurnScript,
  exerciseTurnScript,
  greetingTurnScript,
  quizGradedTurnScript,
  quizTurnScript,
  replyTurnScript,
} from '@/lib/fixtures/turn-preview';
import { TutorRoomView } from '@/components/chat/tutor-room-view';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';

/**
 * Scripted stand-in for the live tutor room: same reducer, same components,
 * same toast/drawer surface — only the transport is replaced by fixtures.
 * Workbench submissions replay grading scripts: the first exercise submit
 * fails, the second passes (the full plans/04 §3 loop without a server).
 */
export function DevTurnPreview() {
  const { publishCommit } = useMemoryCommits();
  const stream = useReplayTurnStream(greetingTurnScript, {
    onCommit: publishCommit,
    getReply: () => replyTurnScript,
  });
  const exerciseAttempts = useRef(0);

  return (
    <div className="flex h-dvh flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b bg-surface-2/50 px-4 py-1.5">
        <span className="font-mono text-caption text-warn">
          dev harness — scripted WsEvent replay through the real reducer
        </span>
        <span className="flex-1" />
        <DevButton label="replay greeting" onClick={() => stream.replay(greetingTurnScript)} />
        <DevButton
          label="push exercise"
          onClick={() => {
            exerciseAttempts.current = 0;
            stream.replay(exerciseTurnScript, { reset: false });
          }}
        />
        <DevButton
          label="push quiz"
          onClick={() => stream.replay(quizTurnScript, { reset: false })}
        />
        <DevButton
          label="push artifact"
          onClick={() => stream.replay(artifactTurnScript, { reset: false })}
        />
        <DevButton
          label="fire commit"
          onClick={() =>
            // Fresh sha each click — the toast provider dedupes by sha.
            publishCommit({
              ...GREETING_COMMIT,
              sha: crypto.randomUUID().replace(/-/g, '') + '00000000',
            })
          }
        />
        <DevButton label="error turn" onClick={() => stream.replay(errorTurnScript)} />
      </div>
      <TutorRoomView
        title="SQL — LEFT JOIN edge cases"
        topicSlug="sql"
        threadId="dev-preview-thread"
        stream={stream}
        onInterrupt={() => stream.replay(errorTurnScript)}
        onSubmitExercise={async () => {
          // First attempt fails, later attempts pass — scripted end to end.
          exerciseAttempts.current += 1;
          stream.replay(
            exerciseAttempts.current === 1 ? exerciseFailTurnScript : exercisePassTurnScript,
            { reset: false },
          );
        }}
        onSubmitQuiz={async () => {
          stream.replay(quizGradedTurnScript, { reset: false });
        }}
      />
    </div>
  );
}

function DevButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-sm border px-2 py-0.5 font-mono text-caption text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
    >
      {label}
    </button>
  );
}
