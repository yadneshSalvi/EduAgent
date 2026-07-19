'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { load as yamlLoad } from 'js-yaml';
import { BookOpen, ChevronRight, FileText, X } from 'lucide-react';
import type { TrackSessions } from '@eduagent/shared';
import { useQuery } from '@tanstack/react-query';
import { Markdown } from '@/components/chat/markdown';
import { splitFrontmatter } from '@/components/memory/file-viewer';
import { Badge } from '@/components/ui/badge';
import { useTrackDetail, useTrackSessions } from '@/hooks/use-tracks';
import { getMemoryFile } from '@/lib/api';
import { ensureOpenKey, toggleOpenKey } from '@/lib/sidebar-state';
import { formatRoadmapDate } from '@/lib/tracks';
import { cn } from '@/lib/utils';

export type SessionRow = TrackSessions['sessions'][number];

export interface SessionGroup {
  day: number | null;
  rows: SessionRow[];
}

function rowTimestamp(row: SessionRow): number {
  const value = row.kind === 'thread' ? row.thread.lastActiveAt : row.date;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

/** Group newest days first, keep legacy rows last, and sort each group newest-first. */
export function groupTrackSessions(rows: SessionRow[]): SessionGroup[] {
  const grouped = new Map<number | null, SessionRow[]>();
  for (const row of rows) {
    const current = grouped.get(row.roadmapDay) ?? [];
    current.push(row);
    grouped.set(row.roadmapDay, current);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    })
    .map(([day, groupedRows]) => ({
      day,
      rows: groupedRows.toSorted((left, right) => rowTimestamp(right) - rowTimestamp(left)),
    }));
}

function groupKey(day: number | null): string {
  return day === null ? 'earlier' : `day:${day}`;
}

function sessionBadge(row: SessionRow): 'learn' | 'revise' | 'fix' | 'log' {
  if (row.kind === 'log') return 'log';
  if (row.thread.intent === 'revise') return 'revise';
  if (row.thread.intent === 'mistakes') return 'fix';
  return 'learn';
}

function compactDate(iso: string): string {
  const value = formatRoadmapDate(iso.slice(0, 10));
  return value?.replace(',', '') ?? iso;
}

function threadDuration(row: Extract<SessionRow, { kind: 'thread' }>): number {
  const elapsed = Date.parse(row.thread.lastActiveAt) - Date.parse(row.thread.createdAt);
  return Math.max(1, Math.round(elapsed / 60_000));
}

function sessionCaption(row: SessionRow): string {
  if (row.kind === 'thread') {
    return `${compactDate(row.thread.lastActiveAt)} · ${threadDuration(row)} min`;
  }
  const duration =
    typeof row.durationEstimate === 'number' ? `${row.durationEstimate} min` : row.durationEstimate;
  return `${compactDate(row.date)} · ${duration}`;
}

function SessionItem({
  row,
  slug,
  activeThreadId,
  onLog,
}: {
  row: SessionRow;
  slug: string;
  activeThreadId: string | null;
  onLog: (row: Extract<SessionRow, { kind: 'log' }>) => void;
}) {
  const badge = sessionBadge(row);
  const title = row.kind === 'thread' ? row.thread.title : row.title;
  const content = (
    <>
      <span className={cn('flex min-w-0 items-center gap-1.5')}>
        <span
          className={cn(
            'shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-caption',
            badge === 'fix'
              ? 'bg-danger/15 text-danger'
              : badge === 'revise'
                ? 'bg-warn/15 text-warn'
                : badge === 'log'
                  ? 'bg-surface-2 text-muted-foreground'
                  : 'bg-accent-soft text-primary-legible',
          )}
        >
          {badge}
        </span>
        <span className={cn('min-w-0 flex-1 truncate text-body-sm font-medium')} title={title}>
          {title}
        </span>
        {row.kind === 'log' ? (
          <FileText className={cn('size-3 shrink-0 text-muted-foreground')} aria-hidden />
        ) : null}
      </span>
      <span
        className={cn('truncate font-mono text-caption text-muted-foreground')}
        title={sessionCaption(row)}
      >
        {sessionCaption(row)}
      </span>
    </>
  );

  if (row.kind === 'log') {
    return (
      <button
        type="button"
        onClick={() => onLog(row)}
        title={title}
        className={cn(
          'flex w-full min-w-0 flex-col gap-1 rounded-md py-2 pl-4 pr-2 text-left text-muted-foreground',
          'transition-colors duration-150 hover:bg-surface-2 hover:text-foreground',
        )}
      >
        {content}
      </button>
    );
  }

  const active = row.thread.id === activeThreadId;
  return (
    <Link
      href={`/app/tracks/${slug}/s/${row.thread.id}`}
      aria-current={active ? 'page' : undefined}
      title={title}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-md py-2 pl-4 pr-2 transition-colors duration-150',
        active
          ? 'bg-accent-soft text-primary-legible'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      {content}
    </Link>
  );
}

function DayGroup({
  group,
  title,
  slug,
  activeThreadId,
  open,
  onToggle,
  onLog,
}: {
  group: SessionGroup;
  title: string;
  slug: string;
  activeThreadId: string | null;
  open: boolean;
  onToggle: () => void;
  onLog: (row: Extract<SessionRow, { kind: 'log' }>) => void;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-0.5')}>
      <h2 className={cn('min-w-0')}>
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          title={title}
          className={cn(
            'flex min-h-8 w-full min-w-0 items-center gap-1 rounded-md px-2 text-left',
            'font-mono text-caption text-muted-foreground transition-colors duration-150',
            'hover:bg-surface-2 hover:text-foreground',
          )}
        >
          <ChevronRight
            className={cn(
              'size-3 shrink-0 transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-90',
            )}
            aria-hidden
          />
          <span className={cn('min-w-0 flex-1 truncate')}>{title}</span>
        </button>
      </h2>
      {open ? (
        <div className={cn('flex min-w-0 flex-col gap-0.5 pl-2')}>
          {group.rows.map((row) => (
            <SessionItem
              key={row.kind === 'thread' ? row.thread.id : row.file}
              row={row}
              slug={slug}
              activeThreadId={activeThreadId}
              onLog={onLog}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function LogSheet({
  row,
  open,
  onClose,
  onExited,
}: {
  row: Extract<SessionRow, { kind: 'log' }>;
  open: boolean;
  onClose: () => void;
  onExited: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const closeRef = useRef<HTMLButtonElement>(null);
  const file = useQuery({
    queryKey: ['memory', 'file', row.file, 'HEAD'],
    queryFn: ({ signal }) => getMemoryFile(row.file, undefined, signal),
  });
  const parsed = file.data ? splitFrontmatter(file.data.content) : null;
  const frontmatter = useMemo(() => {
    if (!parsed?.frontmatter) return [];
    try {
      const value = yamlLoad(parsed.frontmatter);
      return value && typeof value === 'object'
        ? Object.entries(value as Record<string, unknown>).slice(0, 8)
        : [];
    } catch {
      return [];
    }
  }, [parsed?.frontmatter]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [onClose, open]);

  return (
    <div
      className={cn('fixed inset-0 z-[70]', !open && 'pointer-events-none')}
      role="dialog"
      aria-modal="true"
      aria-label="Session log"
    >
      <motion.button
        type="button"
        aria-label="Close session log"
        initial={{ opacity: 0 }}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className={cn('absolute inset-0 bg-black/40')}
      />
      <motion.section
        initial={reducedMotion ? { opacity: 0 } : { y: '100%' }}
        animate={reducedMotion ? { opacity: open ? 1 : 0 } : { y: open ? 0 : '100%' }}
        transition={
          reducedMotion ? { duration: 0.2 } : { type: 'spring', stiffness: 240, damping: 28 }
        }
        onAnimationComplete={() => {
          if (!open) onExited();
        }}
        className={cn(
          'absolute inset-x-0 bottom-0 flex max-h-[70vh] min-h-[45vh] flex-col',
          'rounded-t-xl border-t bg-surface shadow-overlay',
        )}
      >
        <header className={cn('flex min-h-14 items-center gap-3 border-b px-5')}>
          <div className={cn('min-w-0 flex-1')}>
            <h2 className={cn('truncate font-display text-h4 font-medium')} title={row.title}>
              {row.title}
            </h2>
            <p
              className={cn('truncate font-mono text-caption text-muted-foreground')}
              title={row.file}
            >
              {row.file}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close session log"
            className={cn(
              'flex size-10 items-center justify-center rounded-md text-muted-foreground',
              'hover:bg-surface-2 hover:text-foreground',
            )}
          >
            <X className={cn('size-4')} aria-hidden />
          </button>
        </header>
        <div className={cn('min-h-0 flex-1 overflow-y-auto p-6')}>
          <div className={cn('mx-auto flex max-w-3xl flex-col gap-5')}>
            <div className={cn('flex flex-wrap gap-2')}>
              {frontmatter.map(([key, value]) => (
                <Badge key={key} variant="secondary" className={cn('font-mono')}>
                  {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                </Badge>
              ))}
            </div>
            {file.isPending ? (
              <div className={cn('h-48 animate-pulse rounded-lg bg-surface-2')} aria-hidden />
            ) : null}
            {file.isError ? (
              <p className={cn('text-body-sm text-danger')}>The session log could not be read.</p>
            ) : null}
            {parsed ? <Markdown content={parsed.body} /> : null}
          </div>
        </div>
      </motion.section>
    </div>
  );
}

/** Nested roadmap/day/session navigation rendered inside one expanded track row. */
export function SessionTree({ slug, expanded }: { slug: string; expanded: boolean }) {
  const pathname = usePathname();
  const detail = useTrackDetail(slug, expanded);
  const sessions = useTrackSessions(slug, expanded);
  const activeThreadId = /\/s\/([^/]+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const homeActive = pathname === `/app/tracks/${slug}`;
  const titleByDay = useMemo(
    () => new Map(detail.data?.roadmap?.days.map((day) => [day.day, day.title]) ?? []),
    [detail.data?.roadmap?.days],
  );
  const groups = useMemo(
    () => groupTrackSessions(sessions.data?.sessions ?? []),
    [sessions.data?.sessions],
  );
  const activeGroupKey = useMemo(() => {
    if (activeThreadId === null) return null;
    const activeGroup = groups.find((group) =>
      group.rows.some((row) => row.kind === 'thread' && row.thread.id === activeThreadId),
    );
    return activeGroup ? groupKey(activeGroup.day) : null;
  }, [activeThreadId, groups]);
  const [openGroups, setOpenGroups] = useState<Set<string>>(() =>
    activeGroupKey ? new Set([activeGroupKey]) : new Set(),
  );
  const [logRow, setLogRow] = useState<Extract<SessionRow, { kind: 'log' }> | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  useEffect(() => {
    setOpenGroups((current) => ensureOpenKey(current, activeGroupKey));
  }, [activeGroupKey]);

  useEffect(() => {
    if (expanded) return;
    setLogOpen(false);
    setLogRow(null);
  }, [expanded]);

  if (!expanded) return null;

  const openLog = (row: Extract<SessionRow, { kind: 'log' }>) => {
    setLogRow(row);
    setLogOpen(true);
  };

  return (
    <>
      <div className={cn('flex min-w-0 flex-col gap-1 pb-2 pl-4 pr-1')}>
        <Link
          href={`/app/tracks/${slug}`}
          aria-current={homeActive ? 'page' : undefined}
          title="Roadmap"
          className={cn(
            'flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 text-body-sm font-medium',
            'transition-colors duration-150',
            homeActive
              ? 'bg-accent-soft text-primary-legible'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
          )}
        >
          <BookOpen className={cn('size-3.5 shrink-0')} aria-hidden />
          <span className={cn('min-w-0 flex-1 truncate')}>Roadmap</span>
        </Link>

        {sessions.isPending ? (
          <div className={cn('space-y-2 px-2 py-1')} aria-hidden>
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className={cn('h-8 animate-pulse rounded-md bg-surface-2')} />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className={cn('px-2 py-3 font-serif text-body-sm italic text-muted-foreground')}>
            No sessions yet — Day 1 is ready when you are.
          </p>
        ) : (
          <div className={cn('flex min-w-0 flex-col gap-1')}>
            {groups.map((group) => {
              const key = groupKey(group.day);
              const title =
                group.day === null
                  ? 'Earlier sessions'
                  : `day/${String(group.day).padStart(2, '0')} · ${titleByDay.get(group.day) ?? 'Learning session'}`;
              return (
                <DayGroup
                  key={key}
                  group={group}
                  title={title}
                  slug={slug}
                  activeThreadId={activeThreadId}
                  open={openGroups.has(key)}
                  onToggle={() => setOpenGroups((current) => toggleOpenKey(current, key))}
                  onLog={openLog}
                />
              );
            })}
          </div>
        )}
      </div>
      {logRow ? (
        <LogSheet
          row={logRow}
          open={logOpen}
          onClose={() => setLogOpen(false)}
          onExited={() => setLogRow(null)}
        />
      ) : null}
    </>
  );
}
