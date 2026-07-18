'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Flame,
  GitCommitHorizontal,
  GraduationCap,
  LayoutDashboard,
  RotateCcw,
  Search,
  Timer,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useCommandPalette } from '@/components/shared/command-palette';
import { useDashboard } from '@/hooks/use-dashboard';
import { useMe } from '@/hooks/use-me';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/app', icon: LayoutDashboard, exact: true },
  { label: 'Learn', href: '/app/learn', icon: GraduationCap },
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
  '/app': () => void import('@/components/dashboard/decay-chart'),
  '/app/learn': () => void import('@/lib/monaco-react'),
  '/app/exam': () => void import('@/lib/monaco-react'),
  '/app/memory': () => void import('@/lib/monaco-react'),
};
const prefetched = new Set<string>();
function warmChunks(href: string): void {
  if (prefetched.has(href)) return;
  prefetched.add(href);
  CHUNK_PREFETCH[href]?.();
}

export function AppSidebar() {
  const pathname = usePathname();
  // Live due count + streak ride the shared dashboard query (invalidated on
  // every memory.commit); failures just hide the badge — never block nav.
  const { data: dashboard } = useDashboard();
  const dueCount = dashboard
    ? dashboard.reviewQueue.dueToday + dashboard.reviewQueue.overdue
    : 0;

  return (
    <aside className="sticky top-0 flex h-dvh w-16 shrink-0 flex-col border-r bg-surface lg:w-60">
      <div className="flex h-16 items-center justify-center border-b px-2 lg:justify-start lg:px-6">
        <Link
          href="/app"
          // Below lg only the aria-hidden "E" is visible — the label carries
          // the accessible name at every width.
          aria-label="EduAgent — dashboard"
          className="flex h-10 items-center rounded-sm font-display text-h4 font-semibold tracking-tight"
>
          <span className="lg:hidden" aria-hidden>
            E
          </span>
          <span className="hidden lg:inline">EduAgent</span>
        </Link>
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col gap-1 p-2 lg:p-3">
        {NAV_ITEMS.map((item) => {
          const active = item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
          const Icon = item.icon;
          const badge = item.href === '/app/review' ? dueCount : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              title={item.label}
              onMouseEnter={() => warmChunks(item.href)}
              onFocus={() => warmChunks(item.href)}
              className={cn(
                'flex h-10 items-center justify-center gap-3 rounded-md px-0 text-body-sm font-medium transition-colors duration-150 lg:justify-start lg:px-3',
                active
                  ? 'bg-accent-soft text-primary-legible'
                  : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
              )}
            >
              <Icon className="size-4.5 shrink-0" aria-hidden />
              <span className="hidden flex-1 lg:inline">{item.label}</span>
              {badge > 0 ? (
                <Badge
                  variant="accent"
                  className="hidden numeric lg:inline-flex"
                  aria-label={`${badge} reviews due`}
                >
                  {badge}
                </Badge>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <PaletteHint />
      <UserChip streakDays={dashboard?.user.streakDays ?? 0} />
    </aside>
  );
}

/** Advertises the ⌘K layer (plans/04 §11) — judges are developers. */
function PaletteHint() {
  const palette = useCommandPalette();
  if (!palette) return null;
  return (
    <div className="px-2 pb-1 lg:px-3">
      <button
        type="button"
        onClick={palette.open}
        title="Command palette"
        className="flex h-10 w-full items-center justify-center gap-3 rounded-md text-muted-foreground transition-colors duration-150 hover:bg-surface-2 hover:text-foreground lg:justify-start lg:px-3"
      >
        <Search className="size-4.5 shrink-0" aria-hidden />
        <span className="hidden flex-1 text-left text-body-sm font-medium lg:inline">Commands</span>
        <kbd
          aria-hidden
          className="hidden rounded-sm border bg-surface-2 px-1.5 py-0.5 font-mono text-caption lg:inline"
        >
          ⌘K
        </kbd>
      </button>
    </div>
  );
}

/**
 * The user chip: identity from GET /auth/me, streak from the dashboard
 * payload. 401 / unreachable host render the signed-out treatment.
 */
function UserChip({ streakDays }: { streakDays: number }) {
  const { data: me, isPending } = useMe();
  const name = me?.displayName ?? null;

  return (
    <div className="border-t p-2 lg:p-3">
      <Link
        href="/app/settings"
        title="Settings"
        className="flex items-center justify-center gap-3 rounded-md p-2 transition-colors duration-150 hover:bg-surface-2 lg:justify-start"
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
          {name ? name.charAt(0).toUpperCase() : <UserRound className="size-4" />}
        </span>
        <span className="hidden min-w-0 flex-1 flex-col lg:flex">
          <span className={cn('truncate text-body-sm font-medium', isPending && 'opacity-0')}>
            {name ?? 'Not signed in'}
          </span>
          {me ? (
            <span className="truncate font-mono text-caption text-muted-foreground">
              @{me.handle}
            </span>
          ) : null}
        </span>
        {streakDays > 0 ? (
          <span
            className="hidden items-center gap-1 text-warn lg:flex"
            title={`${streakDays}-day streak`}
          >
            <Flame className="size-4" aria-hidden />
            <span className="numeric text-caption font-semibold">{streakDays}</span>
          </span>
        ) : null}
      </Link>
    </div>
  );
}
