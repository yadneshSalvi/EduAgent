import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TrackDetail, TrackSessions } from '@eduagent/shared';
import { Roadmap } from './roadmap';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

/** Seeded-Alex shape (QA G1): HEAD day 13 whose history is log entries only. */
function alexDetail(): TrackDetail {
  return {
    id: 'track-1',
    slug: 'sql-interview',
    title: 'SQL Interview Prep',
    goalType: 'interview',
    status: 'active',
    accent: 'emerald',
    createdAt: '2026-07-01T00:00:00Z',
    lastActiveAt: '2026-07-19T00:00:00Z',
    day: { head: 13, total: 14 },
    completedDays: Array.from({ length: 12 }, (_, index) => index + 1),
    nextPlannedDate: '2026-07-20',
    conceptSlugs: ['left-join'],
    topicSlugs: ['sql'],
    targetDate: '2026-09-02',
    planThreadId: 'plan-thread',
    headDay: 13,
    subtopicsDone: 24,
    subtopicsTotal: 28,
    roadmap: {
      schedule: { study_days: ['mon', 'wed', 'fri'], minutes_per_day: 45, start_date: '2026-07-01' },
      days: Array.from({ length: 14 }, (_, index) => {
        const day = index + 1;
        const complete = day <= 12;
        return {
          day,
          title: `Topic ${day}`,
          status: complete ? ('complete' as const) : ('upcoming' as const),
          completedOn: complete ? '2026-07-10' : null,
          plannedDate: complete ? null : '2026-07-20',
          topics: [{ topic: 'sql', concepts: ['left-join'] }],
          subtopics: ['Part A', 'Part B'],
          sessionCount: day === 13 ? 2 : complete ? 1 : 0,
        };
      }),
    },
  };
}

function render(sessions: TrackSessions): string {
  const client = new QueryClient();
  client.setQueryData(['tracks', 'sql-interview'], alexDetail());
  client.setQueryData(['tracks', 'sql-interview', 'sessions'], sessions);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Roadmap slug="sql-interview" />
    </QueryClientProvider>,
  );
}

const LOG_SESSIONS: TrackSessions = {
  sessions: [
    {
      kind: 'log',
      file: 'sessions/2026-07-18-sql-left-join.md',
      date: '2026-07-18',
      title: 'LEFT JOIN edge cases',
      roadmapDay: 13,
      durationEstimate: '30m',
      mode: 'learn',
    },
    {
      kind: 'log',
      file: 'sessions/2026-07-17-sql-mock.md',
      date: '2026-07-17',
      title: 'Mock drills',
      roadmapDay: 13,
      durationEstimate: '45m',
      mode: 'learn',
    },
  ],
};

function threadSession(status: 'active' | 'archived'): TrackSessions {
  return {
    sessions: [
      {
        kind: 'thread',
        roadmapDay: 13,
        commitCount: 2,
        thread: {
          id: 'thread-13',
          mode: 'learn',
          topicSlug: 'sql',
          trackSlug: 'sql-interview',
          roadmapDay: 13,
          intent: 'teach',
          title: 'Day 13 — Topic 13',
          status,
          forkedFromId: null,
          createdAt: '2026-07-19T09:00:00Z',
          lastActiveAt: '2026-07-19T09:30:00Z',
        },
      },
    ],
  };
}

describe('Roadmap HEAD-day actions (QA G1)', () => {
  it('log-only in-progress HEAD day still offers the primary Start action', () => {
    const html = render(LOG_SESSIONS);
    expect(html).toContain('Start Day 13');
    expect(html).not.toContain('Resume session');
    expect(html).toContain('Revise this topic');
    expect(html).toContain('Learn from my mistakes');
  });

  it('an ACTIVE thread session turns the primary action into Resume', () => {
    const html = render(threadSession('active'));
    expect(html).toContain('Resume session');
    expect(html).not.toContain('Start Day 13');
  });

  it('an archived thread does not swallow the Start action', () => {
    const html = render(threadSession('archived'));
    expect(html).toContain('Start Day 13');
    expect(html).not.toContain('Resume session');
  });
});
