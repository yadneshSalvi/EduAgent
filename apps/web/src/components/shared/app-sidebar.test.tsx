import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppSidebar } from './app-sidebar';

const state = vi.hoisted(() => ({
  pathname: '/app/tracks/sql-interview/s/thread-13',
  sessionTrees: [] as Array<{ slug: string; expanded: boolean }>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => state.pathname,
}));

vi.mock('@/hooks/use-tracks', () => ({
  useTracks: () => ({
    data: [
      { slug: 'sql-interview', title: 'SQL Interview Prep', accent: 'violet' },
      { slug: 'python-dsa', title: 'Python DS&A', accent: 'cyan' },
    ],
  }),
}));

vi.mock('@/hooks/use-dashboard', () => ({ useDashboard: () => ({ data: undefined }) }));
vi.mock('@/hooks/use-me', () => ({ useMe: () => ({ data: undefined, isPending: false }) }));
vi.mock('@/components/shared/command-palette', () => ({ useCommandPalette: () => null }));
vi.mock('@/components/tracks/session-tree', () => ({
  SessionTree: (props: { slug: string; expanded: boolean }) => {
    state.sessionTrees.push(props);
    return null;
  },
}));

describe('AppSidebar track tree', () => {
  it('auto-expands the route-matching track and leaves the other track closed', () => {
    state.sessionTrees = [];
    const html = renderToStaticMarkup(<AppSidebar />);

    expect(state.sessionTrees).toEqual([
      { slug: 'sql-interview', expanded: true },
      { slug: 'python-dsa', expanded: false },
    ]);
    expect(html).toContain('aria-label="Collapse SQL Interview Prep"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain('duration-[240ms]');
  });
});
