import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TrackDetail, TrackSessions } from '@eduagent/shared';
import { SessionTree } from './session-tree';

const navigation = vi.hoisted(() => ({
  pathname: '/app/tracks/sql-interview/s/thread-active',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
}));

const DETAIL: TrackDetail = {
  id: 'track-1',
  slug: 'sql-interview',
  title: 'SQL Interview Prep',
  goalType: 'interview',
  status: 'active',
  accent: 'violet',
  createdAt: '2026-07-01T00:00:00Z',
  lastActiveAt: '2026-07-19T12:00:00Z',
  day: { head: 13, total: 22 },
  completedDays: [12],
  nextPlannedDate: '2026-07-20',
  conceptSlugs: ['left-join'],
  topicSlugs: ['sql'],
  targetDate: '2026-09-01',
  planThreadId: 'plan-thread',
  headDay: 13,
  subtopicsDone: 24,
  subtopicsTotal: 40,
  roadmap: {
    schedule: { study_days: ['mon', 'wed', 'fri'], minutes_per_day: 45, start_date: '2026-07-01' },
    days: [
      {
        day: 12,
        title: 'Mock-interview gap drills',
        status: 'complete',
        completedOn: '2026-07-18',
        plannedDate: null,
        topics: [{ topic: 'sql', concepts: ['joins'] }],
        subtopics: ['Joins'],
        sessionCount: 1,
      },
      {
        day: 13,
        title: 'LEFT JOIN edge cases',
        status: 'upcoming',
        completedOn: null,
        plannedDate: '2026-07-20',
        topics: [{ topic: 'sql', concepts: ['left-join'] }],
        subtopics: ['LEFT JOIN'],
        sessionCount: 2,
      },
    ],
  },
};

const SESSIONS: TrackSessions = {
  sessions: [
    {
      kind: 'thread',
      roadmapDay: 12,
      commitCount: 1,
      thread: {
        id: 'thread-12',
        mode: 'learn',
        topicSlug: 'sql',
        trackSlug: 'sql-interview',
        roadmapDay: 12,
        intent: 'teach',
        title: 'Collapsed day session',
        status: 'archived',
        forkedFromId: null,
        createdAt: '2026-07-18T09:00:00Z',
        lastActiveAt: '2026-07-18T09:30:00Z',
      },
    },
    {
      kind: 'thread',
      roadmapDay: 13,
      commitCount: 2,
      thread: {
        id: 'thread-active',
        mode: 'learn',
        topicSlug: 'sql',
        trackSlug: 'sql-interview',
        roadmapDay: 13,
        intent: 'revise',
        title: 'Active LEFT JOIN session',
        status: 'active',
        forkedFromId: null,
        createdAt: '2026-07-19T09:00:00Z',
        lastActiveAt: '2026-07-19T09:24:00Z',
      },
    },
    {
      kind: 'log',
      file: 'sessions/2026-07-19-left-join.md',
      date: '2026-07-19',
      title: 'Newest LEFT JOIN log',
      roadmapDay: 13,
      durationEstimate: '30m',
      mode: 'learn',
    },
    {
      kind: 'log',
      file: 'sessions/legacy.md',
      date: '2026-06-01',
      title: 'Hidden legacy log',
      roadmapDay: null,
      durationEstimate: '20m',
      mode: 'learn',
    },
  ],
};

function renderTree(): string {
  const client = new QueryClient();
  client.setQueryData(['tracks', 'sql-interview'], DETAIL);
  client.setQueryData(['tracks', 'sql-interview', 'sessions'], SESSIONS);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <SessionTree slug="sql-interview" expanded />
    </QueryClientProvider>,
  );
}

describe('SessionTree nested disclosures', () => {
  it('auto-opens the active session day while later groups start collapsed', () => {
    const html = renderTree();

    expect(html).toMatch(/aria-expanded="true"[^>]*title="day\/13 · LEFT JOIN edge cases"/);
    expect(html).toMatch(/aria-expanded="false"[^>]*title="day\/12 · Mock-interview gap drills"/);
    expect(html).toMatch(/aria-expanded="false"[^>]*title="Earlier sessions"/);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('Active LEFT JOIN session');
    expect(html).not.toContain('Collapsed day session');
    expect(html).not.toContain('Hidden legacy log');
    expect(html.indexOf('Active LEFT JOIN session')).toBeLessThan(
      html.indexOf('Newest LEFT JOIN log'),
    );
    expect(html.indexOf('day/13')).toBeLessThan(html.indexOf('day/12'));
    expect(html.indexOf('day/12')).toBeLessThan(html.indexOf('Earlier sessions'));
  });
});
