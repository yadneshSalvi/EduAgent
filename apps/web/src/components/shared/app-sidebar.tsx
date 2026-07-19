'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronRight,
  Flame,
  GitCommitHorizontal,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RotateCcw,
  Search,
  Timer,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useCommandPalette } from '@/components/shared/command-palette';
import { SessionTree } from '@/components/tracks/session-tree';
import { Badge } from '@/components/ui/badge';
import { useDashboard } from '@/hooks/use-dashboard';
import { useMe } from '@/hooks/use-me';
import { useTracks } from '@/hooks/use-tracks';
import {
  ensureOpenKey,
  readSidebarCollapsed,
  readSidebarTracksOpen,
  toggleOpenKey,
  writeSidebarCollapsed,
  writeSidebarTracksOpen,
} from '@/lib/sidebar-state';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home', href: '/app', icon: Home, exact: true },
  { label: 'Review', href: '/app/review', icon: RotateCcw },
  { label: 'Exam', href: '/app/exam', icon: Timer },
  { label: 'Memory', href: '/app/memory', icon: GitCommitHorizontal },
];

/**
 * Hover/focus intent warms the heavy dynamic chunks behind each route
 * (plans/04 §12) — Link already prefetches the routes themselves. Monaco's
 * editor assets load on mount from /monaco/vs; this pulls the react wrapper
 * chunk so the editor shell is ready the moment the room opens.
 */
const CHUNK_PREFETCH: Record<string, () => void> = {
  '/app/dashboard': () => void import('@/components/dashboard/decay-chart'),
  '/app/exam': () => void import('@/lib/monaco-react'),
  '/app/memory': () => void import('@/lib/monaco-react'),
};
const prefetched = new Set<string>();
function warmChunks(href: string): void {
  if (prefetched.has(href)) return;
  prefetched.add(href);
  CHUNK_PREFETCH[href]?.();
}

function trackSlugFromPath(pathname: string): string | null {
  const slug = /^\/app\/tracks\/([^/]+)/.exec(pathname)?.[1] ?? null;
  return slug === 'new' ? null : slug;
}

/** The application shell's sole sidebar, including the nested track session tree. */
export function AppSidebar() {
  const pathname = usePathname();
  const activeTrackSlug = trackSlugFromPath(pathname);
  const mountedActiveSlug = useRef(activeTrackSlug);
  const { data: tracks = [] } = useTracks();
  const { data: dashboard } = useDashboard();
  const dueCount = dashboard ? dashboard.reviewQueue.dueToday + dashboard.reviewQueue.overdue : 0;
  const [collapsed, setCollapsed] = useState(false);
  const [openTracks, setOpenTracks] = useState<Set<string>>(() =>
    ensureOpenKey(new Set(), activeTrackSlug),
  );
  const [storageReady, setStorageReady] = useState(false);
  const expanded = !collapsed;

  // Preferences load after mount so server and first-client markup agree.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setCollapsed(readSidebarCollapsed(window.localStorage));
    setOpenTracks(
      ensureOpenKey(readSidebarTracksOpen(window.localStorage), mountedActiveSlug.current),
    );
    setStorageReady(true);
  }, []);

  // Navigating into a track opens it once; the learner can still close it.
  useEffect(() => {
    setOpenTracks((current) => ensureOpenKey(current, activeTrackSlug));
  }, [activeTrackSlug]);

  useEffect(() => {
    if (!storageReady || typeof window === 'undefined') return;
    writeSidebarCollapsed(window.localStorage, collapsed);
  }, [collapsed, storageReady]);

  useEffect(() => {
    if (!storageReady || typeof window === 'undefined') return;
    writeSidebarTracksOpen(window.localStorage, openTracks);
  }, [openTracks, storageReady]);

  return (
    <aside
      className={cn(
        'sticky top-0 flex h-dvh w-16 shrink-0 flex-col border-r bg-surface',
        'transition-[width] duration-[240ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none',
        expanded ? 'lg:w-60' : 'lg:w-16',
      )}
    >
      <div
        className={cn(
          'flex h-16 shrink-0 items-center justify-center border-b px-2',
          expanded ? 'lg:justify-start lg:px-3' : 'lg:px-0',
        )}
      >
        <Link
          href="/app"
          aria-label="EduAgent — home"
          className={cn(
            'flex h-10 items-center justify-center rounded-sm font-display text-h4 font-semibold tracking-tight',
            expanded ? 'lg:min-w-0 lg:flex-1 lg:justify-start lg:px-3' : 'lg:w-6',
          )}
        >
          <span className={cn('lg:hidden')} aria-hidden>
            E
          </span>
          {expanded ? (
            <span className={cn('hidden truncate lg:inline')}>EduAgent</span>
          ) : (
            <span className={cn('hidden lg:inline')} aria-hidden>
              E
            </span>
          )}
        </Link>
        <button
          type="button"
          aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
          aria-expanded={expanded}
          aria-controls="app-sidebar-nav"
          onClick={() => setCollapsed((current) => !current)}
          className={cn(
            'hidden size-10 shrink-0 items-center justify-center rounded-md text-muted-foreground lg:flex',
            'transition-colors duration-150 hover:bg-surface-2 hover:text-foreground',
          )}
        >
          {expanded ? (
            <PanelLeftClose className={cn('size-4')} aria-hidden />
          ) : (
            <PanelLeftOpen className={cn('size-4')} aria-hidden />
          )}
        </button>
      </div>

      <nav
        id="app-sidebar-nav"
        aria-label="Main"
        className={cn(
          'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2',
          expanded && 'lg:p-3',
        )}
      >
        <SidebarLink item={NAV_ITEMS[0]!} pathname={pathname} expanded={expanded} />

        <div className={cn('mt-2 flex flex-col gap-1')}>
          {expanded ? (
            <p
              className={cn(
                'hidden px-3 pb-1 font-mono text-caption lowercase text-muted-foreground lg:block',
              )}
            >
              tracks
            </p>
          ) : null}
          {tracks.map((track) => {
            const active = pathname.startsWith(`/app/tracks/${track.slug}`);
            const trackExpanded = openTracks.has(track.slug);
            const initials = track.title
              .split(/\s+/)
              .slice(0, 2)
              .map((word) => word.charAt(0))
              .join('')
              .toUpperCase();
            const treeId = `sidebar-track-${track.slug}`;
            return (
              <div key={track.slug} className={cn('flex min-w-0 flex-col')}>
                <div
                  className={cn(
                    'flex min-w-0 rounded-md transition-colors duration-150',
                    active
                      ? 'bg-accent-soft text-primary-legible'
                      : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
                  )}
                >
                  <Link
                    href={`/app/tracks/${track.slug}`}
                    aria-current={active ? 'page' : undefined}
                    title={track.title}
                    className={cn(
                      'flex min-h-10 min-w-0 flex-1 items-center justify-center gap-3 text-body-sm font-medium',
                      expanded && 'lg:justify-start lg:pl-3',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-semibold',
                        expanded && 'lg:size-2.5 lg:text-[0px]',
                        accentClass(track.accent),
                      )}
                    >
                      {initials || 'T'}
                    </span>
                    {expanded ? (
                      <span className={cn('hidden min-w-0 flex-1 truncate lg:inline')}>
                        {track.title}
                      </span>
                    ) : null}
                  </Link>
                  {expanded ? (
                    <button
                      type="button"
                      aria-label={`${trackExpanded ? 'Collapse' : 'Expand'} ${track.title}`}
                      aria-expanded={trackExpanded}
                      aria-controls={treeId}
                      onClick={() => setOpenTracks((current) => toggleOpenKey(current, track.slug))}
                      className={cn(
                        'hidden size-10 shrink-0 items-center justify-center rounded-md lg:flex',
                        'transition-colors duration-150 hover:bg-surface-2',
                      )}
                    >
                      <ChevronRight
                        className={cn(
                          'size-3.5 transition-transform duration-150 motion-reduce:transition-none',
                          trackExpanded && 'rotate-90',
                        )}
                        aria-hidden
                      />
                    </button>
                  ) : null}
                </div>
                <div id={treeId} className={cn('hidden min-w-0 lg:block')}>
                  <SessionTree slug={track.slug} expanded={expanded && trackExpanded} />
                </div>
              </div>
            );
          })}
        </div>

        {NAV_ITEMS.slice(1).map((item) => (
          <SidebarLink
            key={item.href}
            item={item}
            pathname={pathname}
            expanded={expanded}
            badge={item.href === '/app/review' ? dueCount : 0}
          />
        ))}

        <Link
          href="/app/tracks/new"
          title="New track"
          className={cn(
            'flex h-10 items-center justify-center gap-3 rounded-md px-0 text-body-sm font-medium',
            'text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground',
            expanded && 'lg:justify-start lg:px-3',
          )}
        >
          <Plus className={cn('size-4.5 shrink-0')} aria-hidden />
          {expanded ? <span className={cn('hidden lg:inline')}>New track</span> : null}
        </Link>
      </nav>

      <PaletteHint expanded={expanded} />
      <UserChip streakDays={dashboard?.user.streakDays ?? 0} expanded={expanded} />
    </aside>
  );
}

function SidebarLink({
  item,
  pathname,
  expanded,
  badge = 0,
}: {
  item: NavItem;
  pathname: string;
  expanded: boolean;
  badge?: number;
}) {
  const active = item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      onMouseEnter={() => warmChunks(item.href)}
      onFocus={() => warmChunks(item.href)}
      className={cn(
        'flex h-10 items-center justify-center gap-3 rounded-md px-0 text-body-sm font-medium',
        'transition-colors duration-150',
        expanded && 'lg:justify-start lg:px-3',
        active
          ? 'bg-accent-soft text-primary-legible'
          : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
      )}
    >
      <Icon className={cn('size-4.5 shrink-0')} aria-hidden />
      {expanded ? <span className={cn('hidden flex-1 lg:inline')}>{item.label}</span> : null}
      {expanded && badge > 0 ? (
        <Badge
          variant="accent"
          className={cn('numeric hidden lg:inline-flex')}
          aria-label={`${badge} reviews due`}
        >
          {badge}
        </Badge>
      ) : null}
    </Link>
  );
}

/** Track accents are server-selected names; map them onto existing theme tokens. */
function accentClass(accent: string): string {
  return (
    {
      violet: 'bg-primary text-primary-foreground',
      cyan: 'bg-mastery-50 text-primary-foreground',
      amber: 'bg-warn text-background',
      rose: 'bg-danger text-primary-foreground',
      emerald: 'bg-success text-background',
      blue: 'bg-mastery-25 text-primary-foreground',
    }[accent] ?? 'bg-primary text-primary-foreground'
  );
}

/** Advertises the ⌘K layer (plans/04 §11) — judges are developers. */
function PaletteHint({ expanded }: { expanded: boolean }) {
  const palette = useCommandPalette();
  if (!palette) return null;
  return (
    <div className={cn('px-2 pb-1', expanded && 'lg:px-3')}>
      <button
        type="button"
        onClick={palette.open}
        title="Command palette"
        className={cn(
          'flex h-10 w-full items-center justify-center gap-3 rounded-md text-muted-foreground',
          'transition-colors duration-150 hover:bg-surface-2 hover:text-foreground',
          expanded && 'lg:justify-start lg:px-3',
        )}
      >
        <Search className={cn('size-4.5 shrink-0')} aria-hidden />
        {expanded ? (
          <>
            <span className={cn('hidden flex-1 text-left text-body-sm font-medium lg:inline')}>
              Commands
            </span>
            <kbd
              aria-hidden
              className={cn(
                'hidden rounded-sm border bg-surface-2 px-1.5 py-0.5 font-mono text-caption lg:inline',
              )}
            >
              ⌘K
            </kbd>
          </>
        ) : null}
      </button>
    </div>
  );
}

/**
 * The user chip: identity from GET /auth/me, streak from the dashboard
 * payload. 401 / unreachable host render the signed-out treatment.
 */
function UserChip({ streakDays, expanded }: { streakDays: number; expanded: boolean }) {
  const { data: me, isPending } = useMe();
  const name = me?.displayName ?? null;

  return (
    <div className={cn('border-t p-2', expanded && 'lg:p-3')}>
      <Link
        href="/app/settings"
        title="Settings"
        className={cn(
          'flex items-center justify-center gap-3 rounded-md p-2 transition-colors duration-150',
          'hover:bg-surface-2',
          expanded && 'lg:justify-start',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full',
            name
              ? 'bg-accent-soft text-body-sm font-semibold text-primary-legible'
              : 'bg-surface-2 text-muted-foreground',
          )}
        >
          {name ? name.charAt(0).toUpperCase() : <UserRound className={cn('size-4')} />}
        </span>
        {expanded ? (
          <span className={cn('hidden min-w-0 flex-1 flex-col lg:flex')}>
            <span className={cn('truncate text-body-sm font-medium', isPending && 'opacity-0')}>
              {name ?? 'Not signed in'}
            </span>
            {me ? (
              <span className={cn('truncate font-mono text-caption text-muted-foreground')}>
                @{me.handle}
              </span>
            ) : null}
          </span>
        ) : null}
        {expanded && streakDays > 0 ? (
          <span
            className={cn('hidden items-center gap-1 text-warn lg:flex')}
            title={`${streakDays}-day streak`}
          >
            <Flame className={cn('size-4')} aria-hidden />
            <span className={cn('numeric text-caption font-semibold')}>{streakDays}</span>
          </span>
        ) : null}
      </Link>
    </div>
  );
}
