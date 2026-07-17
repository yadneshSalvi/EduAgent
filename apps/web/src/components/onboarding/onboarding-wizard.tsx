'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { Check, GitCommitHorizontal, Loader2 } from 'lucide-react';
import type { MemoryCommit } from '@eduagent/shared';
import { useMe } from '@/hooks/use-me';
import { useTurnStream, type TurnStream } from '@/hooks/use-turn-stream';
import { useReplayTurnStream } from '@/hooks/use-replay-turn-stream';
import { onboardingGreetingScript, onboardingReplyScripts } from '@/lib/fixtures/turn-preview';
import { ApiConnectionError, ApiError, createThread, interruptThread } from '@/lib/api';
import { ChatInput } from '@/components/chat/chat-input';
import { MessageList } from '@/components/chat/message-list';
import { DiffDrawer } from '@/components/memory/diff-drawer';
import { ErrorState } from '@/components/shared/error-state';
import { Button } from '@/components/ui/button';
import { commitBadge, formatDiffStats, shortSha } from '@/lib/commit-format';
import { cn } from '@/lib/utils';

/**
 * Onboarding (plans/04 §8): full-screen wizard chrome, agent-driven within
 * it — step chips (Goal → Background → Baseline → Ready), the interview in an
 * embedded chat reusing the tutor-room components, and the "your memory was
 * born" finale reusing the Diff Drawer.
 */
const STEPS = ['Goal', 'Background', 'Baseline', 'Ready'] as const;

/**
 * Step position is a client-side heuristic until the server exposes
 * onboarding progress: one step per answered question, Ready on the first
 * profile/seed commit.
 */
function deriveStep(stream: TurnStream['state']): {
  step: number;
  birthCommit: MemoryCommit | null;
} {
  const birthCommit =
    stream.commits.find((commit) => commit.type === 'profile' || commit.type === 'seed') ?? null;
  if (birthCommit) return { step: 3, birthCommit };
  const answers = stream.items.filter((item) => item.role === 'user').length;
  return { step: Math.min(answers, 2), birthCommit: null };
}

function StepChips({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Onboarding steps">
      {STEPS.map((step, index) => (
        <li
          key={step}
          aria-current={index === current ? 'step' : undefined}
          className={cn(
            'flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-caption font-medium',
            index === current
              ? 'border-transparent bg-accent-soft text-primary'
              : index < current
                ? 'border-transparent text-success'
                : 'text-muted-foreground',
          )}
        >
          {index < current ? <Check className="size-3" aria-hidden /> : null}
          {step}
        </li>
      ))}
    </ol>
  );
}

function MemoryBornFinale({
  commit,
  onViewCommit,
}: {
  commit: MemoryCommit;
  onViewCommit: () => void;
}) {
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  return (
    <div className="relative flex flex-1 items-center justify-center overflow-hidden p-8">
      {/* Celebratory-but-tasteful (05 §6): one hero entrance, a quiet glow. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 60% 45% at 50% 42%, color-mix(in srgb, var(--accent) 14%, transparent), transparent)',
        }}
      />
      <motion.div
        initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={
          reducedMotion ? { duration: 0.25 } : { type: 'spring', stiffness: 240, damping: 28 }
        }
        className="relative flex w-full max-w-lg flex-col items-center gap-6 text-center"
      >
        <div className="flex flex-col gap-2">
          <h1 className="font-display text-h1 font-medium italic tracking-tight">
            Your memory was born.
          </h1>
          <p className="text-body text-muted-foreground">
            From now on, every session starts from what you already know — and you can watch every
            change it makes.
          </p>
        </div>

        <button
          type="button"
          onClick={onViewCommit}
          className="w-full rounded-lg border bg-surface p-4 text-left transition-colors duration-150 hover:border-primary/50"
        >
          <div className="flex items-center gap-2">
            <span className="rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-caption text-primary">
              {commitBadge(commit)}
            </span>
            <span className="flex items-center gap-1 font-mono text-caption text-muted-foreground">
              <GitCommitHorizontal className="size-3.5" aria-hidden />
              {shortSha(commit.sha)}
            </span>
          </div>
          <p className="mt-2 text-body-sm font-medium">{commit.headline}</p>
          <p className="mt-1.5 font-mono text-caption text-muted-foreground">
            {formatDiffStats(commit.stats)}
          </p>
        </button>

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={onViewCommit}>
            See the first commit
          </Button>
          <Button onClick={() => router.push('/app')}>Enter EduAgent</Button>
        </div>
      </motion.div>
    </div>
  );
}

function WizardChrome({
  step,
  children,
}: {
  step: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col bg-background">
      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b px-6">
        <span className="font-display text-h4 font-semibold tracking-tight">EduAgent</span>
        <StepChips current={step} />
        <Link
          href="/app"
          className="rounded-sm text-caption text-muted-foreground transition-colors duration-150 hover:text-foreground"
        >
          Skip for now →
        </Link>
      </header>
      {children}
    </div>
  );
}

function OnboardingChat({
  stream,
  onInterrupt,
}: {
  stream: TurnStream;
  onInterrupt: () => void;
}) {
  const { step, birthCommit } = deriveStep(stream.state);
  const [drawerCommit, setDrawerCommit] = useState<MemoryCommit | null>(null);

  return (
    <WizardChrome step={step}>
      {birthCommit ? (
        <MemoryBornFinale commit={birthCommit} onViewCommit={() => setDrawerCommit(birthCommit)} />
      ) : (
        <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
          <MessageList
            state={stream.state}
            emptyHint="The tutor opens the interview — one moment."
            onRetryTurn={() => {
              const lastUser = [...stream.state.items].reverse().find((i) => i.role === 'user');
              if (lastUser) stream.send(lastUser.text);
            }}
          />
          <ChatInput
            onSend={stream.send}
            onInterrupt={onInterrupt}
            turnInFlight={stream.state.turnStatus !== 'idle'}
            connection={stream.state.connection}
            placeholder="Answer the tutor…"
          />
        </div>
      )}
      <DiffDrawer
        commit={drawerCommit}
        onClose={() => setDrawerCommit(null)}
        headerLine="Your memory was born."
      />
    </WizardChrome>
  );
}

/** Preview mode: the same chrome + components on scripted fixtures. */
function OnboardingPreview() {
  const replyIndex = useRef(0);
  const stream = useReplayTurnStream(onboardingGreetingScript, {
    getReply: () => onboardingReplyScripts[replyIndex.current++],
  });
  return <OnboardingChat stream={stream} onInterrupt={() => {}} />;
}

/** Live mode: a real onboarding thread against the agent host. */
function OnboardingLive({ threadId }: { threadId: string }) {
  const stream = useTurnStream(threadId);
  return (
    <OnboardingChat
      stream={stream}
      onInterrupt={() => {
        interruptThread(threadId).catch((err: unknown) => console.warn('interrupt failed', err));
      }}
    />
  );
}

export function OnboardingWizard({ previewMode }: { previewMode: boolean }) {
  const router = useRouter();
  const me = useMe();
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  // Already-onboarded learners revisiting /app/onboarding go home (QA m7) —
  // unless they're mid-flow here (the finale keeps its "memory born" moment
  // even though the profile commit just flipped the flag).
  const alreadyOnboarded = !previewMode && me.data?.onboarded === true;
  useEffect(() => {
    if (alreadyOnboarded && threadId === null) router.replace('/app');
  }, [alreadyOnboarded, threadId, router]);

  useEffect(() => {
    if (previewMode || alreadyOnboarded || me.isPending) return;
    let cancelled = false;
    setError(null);
    // The interview runs on a learn-mode thread; the server drives the
    // interview itself for un-onboarded users (plans/04 §8).
    createThread({ mode: 'learn' })
      .then((thread) => {
        if (!cancelled) setThreadId(thread.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      });
    return () => {
      cancelled = true;
    };
  }, [previewMode, attempt, alreadyOnboarded, me.isPending]);

  if (previewMode) return <OnboardingPreview />;
  if (threadId) return <OnboardingLive threadId={threadId} />;

  if (error !== null) {
    const description =
      error instanceof ApiConnectionError
        ? error.message
        : error instanceof ApiError && error.status === 404
          ? 'The agent host is running but the interview backend is not wired up yet — it lands with the tutor backend.'
          : error instanceof Error
            ? error.message
            : 'Could not start the interview.';
    return (
      <WizardChrome step={0}>
        <div className="flex flex-1 items-center justify-center p-8">
          <ErrorState
            title="The interview can't start yet"
            description={description}
            onRetry={() => setAttempt((n) => n + 1)}
            secondary={
              process.env.NODE_ENV !== 'production' ? (
                <Button asChild variant="outline">
                  <Link href="/app/onboarding?preview=1">Preview the flow</Link>
                </Button>
              ) : null
            }
          />
        </div>
      </WizardChrome>
    );
  }

  return (
    <WizardChrome step={0}>
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-2 font-mono text-caption text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          preparing your workspace…
        </div>
      </div>
    </WizardChrome>
  );
}
