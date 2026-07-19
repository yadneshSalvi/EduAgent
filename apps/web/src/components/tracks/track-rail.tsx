'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { notFound, usePathname } from 'next/navigation';
import { motion, useReducedMotion } from 'motion/react';
import { load as yamlLoad } from 'js-yaml';
import { ArrowLeft, BookOpen, FileText, Menu, X } from 'lucide-react';
import type { TrackSessions } from '@eduagent/shared';
import { useQuery } from '@tanstack/react-query';
import { useTrackDetail, useTrackSessions } from '@/hooks/use-tracks';
import { getMemoryFile } from '@/lib/api';
import { formatRoadmapDate, isTrackNotFound } from '@/lib/tracks';
import { splitFrontmatter } from '@/components/memory/file-viewer';
import { Markdown } from '@/components/chat/markdown';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type SessionRow = TrackSessions['sessions'][number];

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

function SessionItem({
  row,
  slug,
  activeThreadId,
  onLog,
  onNavigate,
}: {
  row: SessionRow;
  slug: string;
  activeThreadId: string | null;
  onLog: (row: Extract<SessionRow, { kind: 'log' }>) => void;
  onNavigate?: () => void;
}) {
  const badge = sessionBadge(row);
  const content = (
    <>
      <span className="flex items-center gap-2">
        <span
          className={cn(
            'rounded-sm px-1.5 py-0.5 font-mono text-caption',
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
        <span className="min-w-0 flex-1 truncate text-body-sm font-medium">
          {row.kind === 'thread' ? row.thread.title : row.title}
        </span>
        {row.kind === 'log' ? (
          <FileText className="size-3 text-muted-foreground" aria-hidden />
        ) : null}
      </span>
      <span className="truncate font-mono text-caption text-muted-foreground">
        {row.kind === 'thread'
          ? `${compactDate(row.thread.lastActiveAt)} · ${threadDuration(row)} min · ${row.commitCount} commits`
          : `${compactDate(row.date)} · ${typeof row.durationEstimate === 'number' ? `${row.durationEstimate} min` : row.durationEstimate} · log`}
      </span>
    </>
  );

  if (row.kind === 'log') {
    return (
      <button
        type="button"
        onClick={() => onLog(row)}
        className="flex w-full flex-col gap-1 rounded-md px-2.5 py-2 text-left text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground"
      >
        {content}
      </button>
    );
  }
  const active = row.thread.id === activeThreadId;
  return (
    <Link
      href={`/app/tracks/${slug}/s/${row.thread.id}`}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex flex-col gap-1 rounded-md px-2.5 py-2 transition-colors duration-150',
        active
          ? 'bg-accent-soft text-primary-legible'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      {content}
    </Link>
  );
}

function RailContent({
  slug,
  onLog,
  onNavigate,
}: {
  slug: string;
  onLog: (row: Extract<SessionRow, { kind: 'log' }>) => void;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const detail = useTrackDetail(slug);
  const sessions = useTrackSessions(slug);
  // Unknown slug (QA F3): the rail lives in the track LAYOUT, so this guard
  // covers every child route — no phantom shell around a nonexistent track.
  if (isTrackNotFound(detail.error) || isTrackNotFound(sessions.error)) notFound();
  const activeThreadId = /\/s\/([^/]+)$/.exec(pathname)?.[1] ?? null;
  const homeActive = pathname === `/app/tracks/${slug}`;
  const titleByDay = useMemo(
    () => new Map(detail.data?.roadmap?.days.map((day) => [day.day, day.title]) ?? []),
    [detail.data?.roadmap?.days],
  );
  const groups = useMemo(() => {
    const map = new Map<number | null, SessionRow[]>();
    for (const row of sessions.data?.sessions ?? []) {
      const day = row.roadmapDay;
      const current = map.get(day) ?? [];
      current.push(row);
      map.set(day, current);
    }
    return [...map.entries()].sort(([left], [right]) => {
      if (left === null) return 1;
      if (right === null) return -1;
      return right - left;
    });
  }, [sessions.data?.sessions]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b p-4">
        <Link
          href="/app"
          onClick={onNavigate}
          className="flex min-h-10 items-center gap-2 text-body-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          All tracks
        </Link>
        <p className="truncate font-display text-lead font-medium">{detail.data?.title ?? slug}</p>
        <Link
          href={`/app/tracks/${slug}`}
          onClick={onNavigate}
          aria-current={homeActive ? 'page' : undefined}
          className={cn(
            'flex h-10 items-center gap-2 rounded-md px-3 text-body-sm font-medium transition-colors duration-150',
            homeActive
              ? 'bg-accent-soft text-primary-legible'
              : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
          )}
        >
          <BookOpen className="size-4" aria-hidden />
          Roadmap
        </Link>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {sessions.isPending ? (
          <div className="animate-pulse space-y-2 p-2" aria-hidden>
            {Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="h-14 rounded-md bg-surface-2" />
            ))}
          </div>
        ) : groups.length === 0 ? (
          <p className="p-4 font-serif italic text-body-sm text-muted-foreground">
            No sessions yet — Day 1 is ready when you are.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            {groups.map(([day, rows]) => (
              <section key={day ?? 'earlier'} className="flex flex-col gap-1">
                <h2 className="px-2.5 font-mono text-caption text-muted-foreground">
                  {day === null
                    ? 'Earlier sessions'
                    : `day/${String(day).padStart(2, '0')} · ${titleByDay.get(day) ?? 'Learning session'}`}
                </h2>
                {rows.map((row) => (
                  <SessionItem
                    key={row.kind === 'thread' ? row.thread.id : row.file}
                    row={row}
                    slug={slug}
                    activeThreadId={activeThreadId}
                    onLog={onLog}
                    onNavigate={onNavigate}
                  />
                ))}
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
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
        className="absolute inset-0 bg-black/40"
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
        className="absolute inset-x-0 bottom-0 flex max-h-[70vh] min-h-[45vh] flex-col rounded-t-xl border-t bg-surface shadow-overlay"
      >
        <header className="flex min-h-14 items-center gap-3 border-b px-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-h4 font-medium">{row.title}</h2>
            <p className="font-mono text-caption text-muted-foreground">{row.file}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close session log"
            className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            <div className="flex flex-wrap gap-2">
              {frontmatter.map(([key, value]) => (
                <Badge key={key} variant="secondary" className="font-mono">
                  {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                </Badge>
              ))}
            </div>
            {file.isPending ? <div className="h-48 animate-pulse rounded-lg bg-surface-2" /> : null}
            {file.isError ? (
              <p className="text-body-sm text-danger">The session log could not be read.</p>
            ) : null}
            {parsed ? <Markdown content={parsed.body} /> : null}
          </div>
        </div>
      </motion.section>
    </div>
  );
}

export function TrackRail({ slug }: { slug: string }) {
  const reducedMotion = useReducedMotion();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [mobileShown, setMobileShown] = useState(false);
  const [logRow, setLogRow] = useState<Extract<SessionRow, { kind: 'log' }> | null>(null);
  const [logOpen, setLogOpen] = useState(false);

  const openMobile = () => {
    setMobileShown(true);
    requestAnimationFrame(() => setMobileOpen(true));
  };
  const closeMobile = () => setMobileOpen(false);
  const openLog = (row: Extract<SessionRow, { kind: 'log' }>) => {
    setLogRow(row);
    setLogOpen(true);
  };

  return (
    <>
      <aside className="hidden h-full w-64 shrink-0 border-r bg-surface lg:block">
        <RailContent slug={slug} onLog={openLog} />
      </aside>
      <div className="shrink-0 border-b bg-surface p-2 lg:hidden">
        <Button variant="ghost" onClick={openMobile}>
          <Menu className="size-4" aria-hidden />
          Track sessions
        </Button>
      </div>
      {mobileShown ? (
        <div className={cn('fixed inset-0 z-[65] lg:hidden', !mobileOpen && 'pointer-events-none')}>
          <motion.button
            type="button"
            aria-label="Close track sessions"
            initial={{ opacity: 0 }}
            animate={{ opacity: mobileOpen ? 1 : 0 }}
            onClick={closeMobile}
            className="absolute inset-0 bg-black/40"
          />
          <motion.aside
            initial={reducedMotion ? { opacity: 0 } : { y: '-100%' }}
            animate={
              reducedMotion ? { opacity: mobileOpen ? 1 : 0 } : { y: mobileOpen ? 0 : '-100%' }
            }
            transition={
              reducedMotion ? { duration: 0.2 } : { type: 'spring', stiffness: 240, damping: 28 }
            }
            onAnimationComplete={() => {
              if (!mobileOpen) setMobileShown(false);
            }}
            className="absolute inset-x-0 top-0 h-[75vh] rounded-b-xl border-b bg-surface shadow-overlay"
          >
            <button
              type="button"
              onClick={closeMobile}
              aria-label="Close track sessions"
              className="absolute right-3 top-3 z-10 flex size-10 items-center justify-center rounded-md bg-surface text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            >
              <X className="size-4" aria-hidden />
            </button>
            <RailContent slug={slug} onLog={openLog} onNavigate={closeMobile} />
          </motion.aside>
        </div>
      ) : null}
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
