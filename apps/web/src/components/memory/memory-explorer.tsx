'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Download,
  GitCommitHorizontal,
  History,
  Loader2,
  Undo2,
} from 'lucide-react';
import type { MemoryCommitType, TimelineEntry } from '@eduagent/shared';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Button } from '@/components/ui/button';
import {
  ApiError,
  getMemoryDiff,
  getMemoryFile,
  getMemoryLog,
  getMemoryTree,
  memoryExportUrl,
} from '@/lib/api';
import { formatDelta, shortSha } from '@/lib/commit-format';
import { formatRelativeTime, formatShortDate } from '@/lib/dashboard-data';
import { summarizeRange } from '@/lib/time-machine';
import { languageForPath, parseUnifiedDiff } from '@/lib/unified-diff';
import { cn } from '@/lib/utils';
import { FileTree, firstFilePath } from './file-tree';
import { FileViewer } from './file-viewer';
import { MonacoFileDiff } from './monaco-file-diff';
import { TimeMachineSlider, type TimeMachineRange } from './time-machine-slider';

/**
 * The memory explorer (plans/04 §7): three panes — file tree · viewer ·
 * commit history — under a Time Machine strip. Scrubbing A/B switches the
 * viewer into an inline Monaco diff with a summary strip computed from the
 * parsed commits in range. "Export my memory" downloads the repo as a zip.
 */
const TYPE_BADGE: Record<MemoryCommitType, string> = {
  learn: 'bg-accent-soft text-primary-legible',
  review: 'bg-success/15 text-success',
  exam: 'bg-warn/15 text-warn',
  misconception: 'bg-danger/15 text-danger',
  profile: 'bg-surface-2 text-muted-foreground',
  seed: 'bg-surface-2 text-muted-foreground',
  system: 'bg-surface-2 text-muted-foreground',
  plan: 'bg-accent-soft text-primary-legible',
};

function HistoryRail({
  commits,
  fileName,
  viewRef,
  onSelect,
}: {
  commits: TimelineEntry[];
  /** Selected file's basename — the rail is that file's history (plans/04 §7). */
  fileName: string | null;
  viewRef: string;
  onSelect: (sha: string) => void;
}) {
  return (
    <aside aria-label="Commit history" className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 truncate border-b px-4 py-2.5 font-mono text-caption uppercase tracking-wide text-muted-foreground">
        history{fileName !== null ? ` · ${fileName}` : ''}
      </p>
      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {commits.map((commit, index) => {
          const active = viewRef === commit.sha || (viewRef === 'HEAD' && index === 0);
          return (
            <li key={commit.sha}>
              <button
                type="button"
                onClick={() => onSelect(index === 0 ? 'HEAD' : commit.sha)}
                aria-current={active ? 'true' : undefined}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left transition-colors duration-150',
                  active ? 'bg-accent-soft' : 'hover:bg-surface-2',
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-caption',
                      TYPE_BADGE[commit.type],
                    )}
                  >
                    {commit.type}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
                    {formatRelativeTime(commit.date)}
                  </span>
                </span>
                <span className="line-clamp-2 text-body-sm leading-snug">{commit.headline}</span>
                <span className="font-mono text-caption text-muted-foreground">
                  {shortSha(commit.sha)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function DiffSummaryStrip({
  commits,
  fromSha,
  toSha,
  fromDate,
  toDate,
}: {
  commits: TimelineEntry[];
  fromSha: string;
  toSha: string;
  fromDate: string;
  toDate: string;
}) {
  const summary = useMemo(
    () => summarizeRange(commits, fromSha, toSha),
    [commits, fromSha, toSha],
  );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b bg-surface-2/40 px-4 py-2.5">
      <p className="font-serif text-body-sm italic text-muted-foreground">
        Between {formatShortDate(fromDate)} and {formatShortDate(toDate)} you:
      </p>
      <span className="numeric font-mono text-caption">
        {summary.commitCount} commit{summary.commitCount === 1 ? '' : 's'}
      </span>
      {summary.conceptsAdded > 0 ? (
        <span className="numeric font-mono text-caption text-success">
          +{summary.conceptsAdded} concept{summary.conceptsAdded === 1 ? '' : 's'}
        </span>
      ) : null}
      {summary.deltas.slice(0, 4).map((delta) => (
        <span
          key={delta.concept}
          className="numeric rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption"
        >
          {formatDelta(delta)}
        </span>
      ))}
      {summary.misconceptionsOpened > 0 ? (
        <span className="font-mono text-caption text-danger">
          {summary.misconceptionsOpened} misconception
          {summary.misconceptionsOpened === 1 ? '' : 's'} caught
        </span>
      ) : null}
      {summary.misconceptionsResolved > 0 ? (
        <span className="font-mono text-caption text-success">
          {summary.misconceptionsResolved} resolved
        </span>
      ) : null}
    </div>
  );
}

function RangeDiff({
  commits,
  fromSha,
  toSha,
  fromDate,
  toDate,
}: {
  commits: TimelineEntry[];
  fromSha: string;
  toSha: string;
  fromDate: string;
  toDate: string;
}) {
  const diffQuery = useQuery({
    queryKey: ['memory', 'diff', fromSha, toSha],
    queryFn: ({ signal }) => getMemoryDiff(fromSha, toSha, undefined, signal),
    staleTime: Infinity,
  });
  const files = useMemo(
    () => (diffQuery.data ? parseUnifiedDiff(diffQuery.data.diff) : []),
    [diffQuery.data],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const activeFile = files[Math.min(activeIndex, Math.max(files.length - 1, 0))];

  if (diffQuery.isPending) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 font-mono text-caption text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        diffing your memory…
      </div>
    );
  }
  if (diffQuery.isError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <ErrorState
          title="The diff didn't come back"
          description="Scrub again or pick a different range — your memory is intact."
          onRetry={() => void diffQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <DiffSummaryStrip
        commits={commits}
        fromSha={fromSha}
        toSha={toSha}
        fromDate={fromDate}
        toDate={toDate}
      />
      {files.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-3 py-1.5">
          {files.map((file, index) => (
            <button
              key={file.path}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={cn(
                'flex h-10 shrink-0 items-center rounded-sm px-2.5 font-mono text-caption transition-colors duration-150',
                index === activeIndex
                  ? 'bg-accent-soft text-primary-legible'
                  : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
              )}
            >
              {file.path}
              <span className="ml-1.5 text-success">+{file.insertions}</span>{' '}
              <span className="text-danger">−{file.deletions}</span>
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {activeFile ? (
          <MonacoFileDiff
            key={`${fromSha}..${toSha}:${activeFile.path}`}
            original={activeFile.original}
            modified={activeFile.modified}
            language={languageForPath(activeFile.path)}
          />
        ) : (
          <div className="flex h-full items-center justify-center font-mono text-caption text-muted-foreground">
            nothing changed between these commits
          </div>
        )}
      </div>
    </div>
  );
}

export function MemoryExplorer() {
  const treeQuery = useQuery({
    queryKey: ['memory', 'tree'],
    queryFn: ({ signal }) => getMemoryTree(signal),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 2,
  });
  const logQuery = useQuery({
    queryKey: ['memory', 'log'],
    queryFn: ({ signal }) => getMemoryLog({ limit: 500 }, signal),
    retry: false,
  });

  const newestFirst = useMemo(() => logQuery.data?.commits ?? [], [logQuery.data]);
  const oldestFirst = useMemo(() => [...newestFirst].reverse(), [newestFirst]);

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [viewRef, setViewRef] = useState('HEAD');
  const [range, setRange] = useState<TimeMachineRange | null>(null);

  const tree = treeQuery.data?.tree ?? [];
  const defaultPath = useMemo(() => {
    if (tree.some((node) => node.path === 'profile.md')) return 'profile.md';
    return firstFilePath(tree);
  }, [tree]);
  const path = selectedPath ?? defaultPath;

  const fileQuery = useQuery({
    queryKey: ['memory', 'file', path, viewRef],
    queryFn: ({ signal }) => getMemoryFile(path!, viewRef === 'HEAD' ? undefined : viewRef, signal),
    enabled: path !== null,
    retry: false,
  });

  // The right rail is the SELECTED FILE's history (plans/04 §7); the full
  // journal above feeds the time machine.
  const fileLogQuery = useQuery({
    queryKey: ['memory', 'log', 'file', path],
    queryFn: ({ signal }) => getMemoryLog({ limit: 200, path: path! }, signal),
    enabled: path !== null,
    retry: false,
  });
  const railCommits = path !== null ? (fileLogQuery.data?.commits ?? []) : newestFirst;

  // Pre-onboarding (404 no_memory): the designed empty state, not a crash.
  if (treeQuery.error instanceof ApiError && treeQuery.error.status === 404) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <EmptyState
          icon={GitCommitHorizontal}
          title="Your memory hasn't been born yet."
          description="Once you finish onboarding, the tutor keeps versioned files about you here — profile, mastery, misconceptions — every change a readable git commit."
          example="git log --oneline memory/"
          cta={{ label: 'Start onboarding', href: '/app/learn' }}
        />
      </div>
    );
  }

  if (treeQuery.isError) {
    // 401 means the SESSION ended, not that the host is down (QA F5) — say
    // so, and route to login instead of a retry that will 401 again.
    const signedOut =
      treeQuery.error instanceof ApiError && treeQuery.error.code === 'unauthenticated';
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        {signedOut ? (
          <ErrorState
            title="You're signed out"
            description="Your session ended, so the agent host turned this request away. Your memory is intact — log back in to see it."
            secondary={
              <Button asChild>
                <a href="/login">Log in</a>
              </Button>
            }
          />
        ) : (
          <ErrorState
            title="The memory explorer can't load"
            description="The agent host didn't answer. Your memory is intact — retry hits the same endpoint."
            detail={treeQuery.error instanceof Error ? treeQuery.error.message : undefined}
            onRetry={() => void treeQuery.refetch()}
          />
        )}
      </div>
    );
  }

  const diffActive = range !== null && range.a !== range.b && oldestFirst.length > 1;
  const rangeSafe: TimeMachineRange = range ?? {
    a: Math.max(0, oldestFirst.length - 1),
    b: Math.max(0, oldestFirst.length - 1),
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-4 border-b px-6 py-4">
        <div className="flex min-w-0 flex-col">
          <h1 className="font-display text-h3 font-medium tracking-tight">Memory</h1>
          <p className="font-mono text-caption text-muted-foreground">
            {newestFirst.length} commits · versioned in git · yours to keep
          </p>
        </div>
        <div className="flex-1" />
        <Button asChild variant="outline" className="gap-2">
          <a href={memoryExportUrl()} download>
            <Download className="size-4" aria-hidden />
            Export my memory
          </a>
        </Button>
      </header>

      {oldestFirst.length > 1 ? (
        <div className="border-b bg-surface px-6 py-3">
          <div className="flex items-center gap-3">
            <History className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="shrink-0 font-mono text-caption uppercase tracking-wide text-muted-foreground">
              time machine
            </span>
            <div className="min-w-0 flex-1">
              <TimeMachineSlider commits={oldestFirst} range={rangeSafe} onChange={setRange} />
            </div>
            {diffActive ? (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-muted-foreground"
                onClick={() => setRange(null)}
              >
                <Undo2 className="size-3.5" aria-hidden />
                Back to now
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[240px_1fr_260px]">
        <div className="hidden min-h-0 border-r lg:block">
          {treeQuery.isPending ? (
            <div className="animate-pulse space-y-2 p-4">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-4 rounded-sm bg-surface-2" />
              ))}
            </div>
          ) : (
            <FileTree
              tree={tree}
              selectedPath={path}
              onSelect={(next) => {
                setSelectedPath(next);
                setRange(null);
              }}
            />
          )}
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          {diffActive ? (
            <RangeDiff
              commits={newestFirst}
              fromSha={oldestFirst[rangeSafe.a]!.sha}
              toSha={oldestFirst[rangeSafe.b]!.sha}
              fromDate={oldestFirst[rangeSafe.a]!.date}
              toDate={oldestFirst[rangeSafe.b]!.date}
            />
          ) : (
            <>
              {viewRef !== 'HEAD' ? (
                <div className="flex items-center gap-3 border-b bg-surface-2/40 px-4 py-2">
                  <p className="min-w-0 flex-1 truncate font-mono text-caption text-muted-foreground">
                    viewing {path} at {shortSha(viewRef)}
                  </p>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="gap-1.5 text-muted-foreground"
                    onClick={() => setViewRef('HEAD')}
                  >
                    <Undo2 className="size-3.5" aria-hidden />
                    Back to current
                  </Button>
                </div>
              ) : null}
              <div className="min-h-0 flex-1 overflow-y-auto">
                {path === null ? (
                  <div className="flex h-full items-center justify-center font-mono text-caption text-muted-foreground">
                    no committed files yet
                  </div>
                ) : fileQuery.isPending ? (
                  <div className="animate-pulse space-y-3 p-6">
                    {Array.from({ length: 10 }, (_, i) => (
                      <div key={i} className="h-4 rounded-sm bg-surface-2" style={{ width: `${90 - (i % 4) * 15}%` }} />
                    ))}
                  </div>
                ) : fileQuery.isError ? (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
                    <p className="text-body-sm text-muted-foreground">
                      {fileQuery.error instanceof ApiError && fileQuery.error.status === 404
                        ? "This file didn't exist at that point in your history."
                        : "The file didn't come back from the agent host."}
                    </p>
                    <Button size="sm" variant="outline" onClick={() => setViewRef('HEAD')}>
                      Back to current
                    </Button>
                  </div>
                ) : (
                  <FileViewer path={fileQuery.data.path} content={fileQuery.data.content} />
                )}
              </div>
            </>
          )}
        </div>

        <div className="hidden min-h-0 border-l lg:block">
          {logQuery.isPending || (path !== null && fileLogQuery.isPending) ? (
            <div className="animate-pulse space-y-3 p-4">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-14 rounded-md bg-surface-2" />
              ))}
            </div>
          ) : (
            <HistoryRail
              commits={railCommits}
              fileName={path !== null ? (path.split('/').at(-1) ?? path) : null}
              viewRef={viewRef}
              onSelect={(sha) => {
                setViewRef(sha);
                setRange(null);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
