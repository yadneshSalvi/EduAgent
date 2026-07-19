import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TrackDetail } from '@eduagent/shared';
import { SessionWrapCard } from './session-wrap-card';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

const DETAIL: TrackDetail = {
  id: 'track-1',
  slug: 'sql-interview',
  title: 'SQL Interview Prep',
  goalType: 'interview',
  status: 'active',
  accent: 'violet',
  createdAt: '2026-07-01T00:00:00Z',
  lastActiveAt: '2026-07-19T00:00:00Z',
  day: { head: 14, total: 22 },
  completedDays: [13],
  nextPlannedDate: '2026-07-20',
  conceptSlugs: ['window-functions'],
  topicSlugs: ['sql'],
  targetDate: '2026-09-01',
  planThreadId: 'plan-thread',
  roadmap: null,
  headDay: 14,
  subtopicsDone: 2,
  subtopicsTotal: 10,
};

describe('SessionWrapCard', () => {
  it('renders all three actions and disables an already-complete day with a check state', () => {
    const client = new QueryClient();
    client.setQueryData(['tracks', 'sql-interview'], DETAIL);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <SessionWrapCard
          trackSlug="sql-interview"
          threadId="thread-13"
          message={{
            id: 'wrap-1',
            role: 'agent',
            kind: 'wrap',
            text: 'Window functions clicked.',
            wrap: {
              day: 13,
              summary_md: 'Window functions clicked.',
              concept_deltas: [{ topic: 'sql', concept: 'window-functions', from: 0.42, to: 0.68 }],
            },
          }}
        />
      </QueryClientProvider>,
    );
    expect(html).toContain('Good stopping point.');
    expect(html).toContain('Day 13 complete');
    expect(html).toContain('disabled=""');
    expect(html).toContain('Revise this topic');
    expect(html).toContain('Learn from my mistakes');
    expect(html).toContain('window-functions');
  });
});
