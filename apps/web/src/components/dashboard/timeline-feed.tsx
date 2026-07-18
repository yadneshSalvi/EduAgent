'use client';

import { useEffect, useState } from 'react';
import { ChevronDown, FileDiff, Loader2 } from 'lucide-react';
import type { MemoryCommitType, TimelineEntry } from '@eduagent/shared';
import { useMemoryCommits } from '@/components/memory/memory-commit-provider';
import { Button } from '@/components/ui/button';
import { getMemoryDiff, getMemoryLog } from '@/lib/api';
import { commitBadge, formatDelta, shortSha } from '@/lib/commit-format';
import { formatRelativeTime } from '@/lib/dashboard-data';
import { cn } from '@/lib/utils';

/**
 * Memory timeline (plans/04 §4): the git-log feed. Type badge, headline,
 * delta chips, relative time; expanding reveals bullets + "View diff", which
 * fetches /api/memory/diff (parent → sha) and opens the existing Diff Drawer.
 * Pages through /api/memory/log via the additive `skip` param.
 */
const PAGE_SIZE = 50;

/** git's canonical empty-tree object — the "parent" of a root commit. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const TYPE_BADGE: Record<MemoryCommitType, string> = {
  learn: 'bg-accent-soft text-primary-legible',
  review: 'bg-success/15 text-success',
  exam: 'bg-warn/15 text-warn',
  misconception: 'bg-danger/15 text-danger',
  profile: 'bg-surface-2 text-muted-foreground',
  seed: 'bg-surface-2 text-muted-foreground',
  system: 'bg-surface-2 text-muted-foreground',
};

function TimelineRow({
  entry,
  parentSha,
  hasMorePages,
  absoluteIndex,
}: {
  entry: TimelineEntry;
  parentSha: string | null;
  hasMorePages: boolean;
  absoluteIndex: number;
}) {
  const { openDrawer } = useMemoryCommits();
  const [expanded, setExpanded] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);

  const viewDiff = async () => {
    setDiffBusy(true);
    setDiffError(null);
    try {
      let from = parentSha;
      if (from === null && hasMorePages) {
        // Last loaded entry of a longer log — resolve its parent on demand.
        const { commits } = await getMemoryLog({ limit: 1, skip: absoluteIndex + 1 });
        from = commits[0]?.sha ?? null;
      }
      from ??= EMPTY_TREE_SHA;
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
      setDiffError("The diff didn't come back — try again.");
    } finally {
      setDiffBusy(false);
    }
  };

  return (
    <li className="relative flex flex-col gap-2 border-l-2 border-border py-3 pl-4">
      <span
        aria-hidden
        className="absolute -left-[5px] top-[1.35rem] size-2 rounded-full border-2 border-surface bg-border"
      />
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        // -my-3 grows the hit box into the li's own py-3 (05 §9 ≥40px) —
        // no background, so the visual row is unchanged.
        className="group -my-3 flex w-full items-start gap-2.5 py-3 text-left"
      >
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-caption',
            TYPE_BADGE[entry.type],
          )}
        >
          {commitBadge(entry)}
        </span>
        <span className="min-w-0 flex-1 text-body-sm font-medium leading-snug group-hover:text-foreground">
          {entry.headline}
        </span>
        <span className="mt-0.5 flex shrink-0 items-center gap-1.5 font-mono text-caption text-muted-foreground">
          {formatRelativeTime(entry.date)}
          <ChevronDown
            aria-hidden
            className={cn('size-3.5 transition-transform duration-150', expanded && 'rotate-180')}
          />
        </span>
      </button>

      {entry.deltas.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {entry.deltas.map((delta) => (
            <span
              key={delta.concept}
              className="numeric rounded-sm bg-surface-2 px-1.5 py-0.5 font-mono text-caption text-muted-foreground"
            >
              {formatDelta(delta)}
            </span>
          ))}
        </div>
      ) : null}

      {expanded ? (
        <div className="flex flex-col gap-2.5">
          {entry.bullets.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {entry.bullets.map((bullet, index) => (
                <li
                  key={index}
                  className="border-l-2 border-border pl-2.5 text-body-sm text-muted-foreground"
                >
                  {bullet}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={diffBusy}
              onClick={() => void viewDiff()}
            >
              {diffBusy ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <FileDiff className="size-3.5" aria-hidden />
              )}
              View diff
            </Button>
            <span className="font-mono text-caption text-muted-foreground">
              {shortSha(entry.sha)}
            </span>
            {diffError ? <span className="text-caption text-danger">{diffError}</span> : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function TimelineFeed({ timeline }: { timeline: TimelineEntry[] }) {
  const [extra, setExtra] = useState<TimelineEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(timeline.length < PAGE_SIZE);

  // A new commit re-anchors the whole feed (fresh dashboard payload) — reset
  // pagination so skip offsets stay aligned with the server's log.
  const headSha = timeline[0]?.sha;
  const timelineLength = timeline.length;
  useEffect(() => {
    setExtra([]);
    setExhausted(timelineLength < PAGE_SIZE);
  }, [headSha, timelineLength]);

  const entries = [...timeline, ...extra];

  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const { commits } = await getMemoryLog({ limit: PAGE_SIZE, skip: entries.length });
      setExtra((current) => [...current, ...commits]);
      if (commits.length < PAGE_SIZE) setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <section aria-label="Memory timeline" className="flex h-full min-h-0 flex-col gap-4 rounded-lg border bg-surface p-6">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="text-lead font-medium">Memory timeline</h2>
        <p className="font-mono text-caption text-muted-foreground">
          <span className="numeric">{entries.length}</span> commits
        </p>
      </header>

      <ul className="flex min-h-0 flex-col overflow-y-auto pr-1">
        {entries.map((entry, index) => (
          <TimelineRow
            key={entry.sha}
            entry={entry}
            parentSha={entries[index + 1]?.sha ?? null}
            hasMorePages={!exhausted}
            absoluteIndex={index}
          />
        ))}
      </ul>

      {!exhausted ? (
        <Button
          size="sm"
          variant="ghost"
          // shrink-0: the column flex parent would squeeze h-10 to ~22px.
          className="shrink-0 gap-1.5 self-center text-muted-foreground"
          disabled={loadingMore}
          onClick={() => void loadMore()}
        >
          {loadingMore ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
          Load older commits
        </Button>
      ) : null}
    </section>
  );
}
