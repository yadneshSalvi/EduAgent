'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Flame,
  GitCommitHorizontal,
  GraduationCap,
  LayoutDashboard,
  RotateCcw,
  Timer,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { PLACEHOLDER_DUE_COUNT, PLACEHOLDER_USER } from '@/lib/placeholder-data';
import { cn } from '@/lib/utils';

interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  exact?: boolean;
  badge?: number;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', href: '/app', icon: LayoutDashboard, exact: true },
  { label: 'Learn', href: '/app/learn', icon: GraduationCap },
  { label: 'Review', href: '/app/review', icon: RotateCcw, badge: PLACEHOLDER_DUE_COUNT },
  { label: 'Exam', href: '/app/exam', icon: Timer },
  { label: 'Memory', href: '/app/memory', icon: GitCommitHorizontal },
];

export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside className="sticky top-0 flex h-dvh w-16 shrink-0 flex-col border-r bg-surface lg:w-60">
      <div className="flex h-16 items-center justify-center border-b px-2 lg:justify-start lg:px-6">
        <Link href="/app" className="rounded-sm font-display text-h4 font-semibold tracking-tight">
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
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              title={item.label}
              className={cn(
                'flex h-10 items-center justify-center gap-3 rounded-md px-0 text-body-sm font-medium transition-colors duration-150 lg:justify-start lg:px-3',
                active
                  ? 'bg-accent-soft text-primary'
                  : 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
              )}
            >
              <Icon className="size-4.5 shrink-0" aria-hidden />
              <span className="hidden flex-1 lg:inline">{item.label}</span>
              {item.badge ? (
                <Badge variant="accent" className="hidden numeric lg:inline-flex">
                  {item.badge}
                </Badge>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t p-2 lg:p-3">
        <Link
          href="/app/settings"
          title="Settings"
          className="flex items-center justify-center gap-3 rounded-md p-2 transition-colors duration-150 hover:bg-surface-2 lg:justify-start"
        >
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-body-sm font-semibold text-primary"
          >
            {PLACEHOLDER_USER.name.charAt(0)}
          </span>
          <span className="hidden min-w-0 flex-1 flex-col lg:flex">
            <span className="truncate text-body-sm font-medium">{PLACEHOLDER_USER.name}</span>
            <span className="text-caption text-muted-foreground">
              {PLACEHOLDER_USER.streakDays > 0
                ? `day ${PLACEHOLDER_USER.streakDays} streak`
                : 'no streak yet'}
            </span>
          </span>
          {PLACEHOLDER_USER.streakDays > 0 ? (
            <span className="hidden items-center gap-1 text-warn lg:flex">
              <Flame className="size-4" aria-hidden />
              <span className="numeric text-caption font-semibold">
                {PLACEHOLDER_USER.streakDays}
              </span>
            </span>
          ) : null}
        </Link>
      </div>
    </aside>
  );
}
