import { describe, expect, it } from 'vitest';
import { estimateTokens, STATE_DIGEST_TOKEN_BUDGET } from '../src/prompts/index.js';
import { formatStateDigest } from '../src/workspace/index.js';
import type { LearnerModel } from '../src/workspace/index.js';

const NOW = new Date('2026-07-17T00:00:00Z');

function fixtureModel(): LearnerModel {
  return {
    profile: {
      frontmatter: {
        name: 'Alex',
        goal: 'Pass backend engineer interviews by September 2026',
        tracks: ['sql-interview'],
        preferences: { session_length: 'short', style: 'socratic' },
        timezone: 'America/Los_Angeles',
      },
      body: 'Alex is a mid-level frontend dev moving to backend.',
    },
    tracks: [
      {
        track: 'sql-interview',
        display_name: 'SQL Interview Prep',
        target_date: '2026-09-01',
        items: [{ concept: 'inner-join', topic: 'sql', weight: 1.5 }],
      },
    ],
    topics: [
      {
        topic: 'sql',
        displayName: 'SQL',
        mastery: {
          topic: 'sql',
          display_name: 'SQL',
          updated: '2026-07-16T18:30:00.000Z',
          concepts: [
            {
              id: 'inner-join',
              name: 'INNER JOIN',
              mastery: 0.72,
              confidence: 'high',
              // 7 days before NOW with review_count 3 → half-life 56d → 0.72·2^(−7/56) ≈ 0.66
              last_assessed: '2026-07-10',
              review_count: 3,
              prereqs: ['select-basics'],
              evidence: [{ date: '2026-07-10', note: 'Solved ex-014 without hints' }],
            },
            {
              id: 'window-functions',
              name: 'Window functions',
              mastery: 0.8,
              confidence: 'medium',
              // 7 days, review_count 0 → half-life 7d → exactly one half-life → 0.40, fading
              last_assessed: '2026-07-10',
              review_count: 0,
              prereqs: [],
              evidence: [{ date: '2026-07-10', note: 'Explained ROW_NUMBER correctly' }],
            },
            {
              id: 'select-basics',
              name: 'SELECT basics',
              mastery: 0.9,
              confidence: 'high',
              // 1 day, review_count 4 → half-life 112d → ≈0.89
              last_assessed: '2026-07-16',
              review_count: 4,
              prereqs: [],
              evidence: [{ date: '2026-07-16', note: 'Perfect quiz q-040' }],
            },
          ],
        },
        openMisconceptions: ['Believes WHERE filters before JOIN completes'],
      },
    ],
    srs: {
      items: [
        {
          concept: 'inner-join',
          topic: 'sql',
          due: '2026-07-15',
          interval_days: 3,
          ease: 2.5,
          lapses: 1,
        },
        {
          concept: 'window-functions',
          topic: 'sql',
          due: '2026-07-17',
          interval_days: 1,
          ease: 2.3,
          lapses: 0,
        },
        {
          concept: 'select-basics',
          topic: 'sql',
          due: '2026-08-01',
          interval_days: 14,
          ease: 2.8,
          lapses: 0,
        },
      ],
    },
    lastSession: {
      file: 'sessions/2026-07-16-sql-joins.md',
      frontmatter: {
        date: '2026-07-16',
        mode: 'learn',
        topics: ['sql'],
        duration_estimate: '25m',
        concepts_touched: ['inner-join'],
        next_time: 'LEFT JOIN edge cases with NULLs',
      },
      body: 'Worked through INNER vs LEFT JOIN.',
    },
    needsRepair: [],
  };
}

describe('formatStateDigest', () => {
  it('matches the golden digest for the fixture model', () => {
    expect(formatStateDigest(fixtureModel(), { now: NOW })).toBe(
      [
        '[LEARNER STATE 2026-07-17]',
        'Learner: Alex — goal: Pass backend engineer interviews by September 2026',
        'Preferences: session_length=short · style=socratic · timezone: America/Los_Angeles',
        'Tracks: SQL Interview Prep (sql-interview, target 2026-09-01)',
        'Concepts tracked: 3. Weakest by effective mastery (raw × time decay):',
        '- sql/window-functions (Window functions): effective 0.40, raw 0.80 — FADING, needs review',
        '- sql/inner-join (INNER JOIN): effective 0.66, raw 0.72',
        '- sql/select-basics (SELECT basics): effective 0.89, raw 0.90',
        'Reviews due: 2 (1 overdue) — next up: sql/inner-join, sql/window-functions',
        'Open misconceptions:',
        '- [sql] Believes WHERE filters before JOIN completes',
        'Last session 2026-07-16 (learn, sql) — next time: LEFT JOIN edge cases with NULLs',
      ].join('\n'),
    );
  });

  it('handles a fresh, pre-onboarding model', () => {
    const digest = formatStateDigest(
      {
        profile: null,
        tracks: [],
        topics: [],
        srs: { items: [] },
        lastSession: null,
        needsRepair: [],
      },
      { now: NOW },
    );
    expect(digest).toContain('has not completed onboarding');
    expect(digest).toContain('Reviews due: none');
  });

  it('lists files needing repair', () => {
    const model = fixtureModel();
    model.needsRepair = ['topics/sql/mastery.yaml'];
    expect(formatStateDigest(model, { now: NOW })).toContain(
      'NEEDS REPAIR (invalid on disk, showing last-known-good): topics/sql/mastery.yaml',
    );
  });

  it('stays under the token budget even for an absurdly large model', () => {
    const model = fixtureModel();
    model.tracks = Array.from({ length: 25 }, (_, i) => ({
      track: `track-${i}`,
      display_name: `An Extremely Long Track Display Name For Stress Testing ${i}`,
      target_date: '2026-12-31',
      items: [{ concept: 'x', topic: 'sql', weight: 1 }],
    }));
    model.topics = Array.from({ length: 40 }, (_, t) => ({
      topic: `topic-${t}`,
      displayName: `Topic ${t}`,
      mastery: {
        topic: `topic-${t}`,
        display_name: `Topic ${t}`,
        updated: '2026-07-16T18:30:00.000Z',
        concepts: Array.from({ length: 30 }, (_, c) => ({
          id: `concept-${c}`,
          name: `A Verbose Concept Name Number ${c} With Extra Words Attached`,
          mastery: (c % 10) / 10,
          confidence: 'low' as const,
          last_assessed: '2026-07-01',
          review_count: c % 5,
          prereqs: [],
          evidence: [{ date: '2026-07-01', note: 'stress' }],
        })),
      },
      openMisconceptions: Array.from({ length: 5 }, (_, m) =>
        `Misconception ${m}: a very long-winded description of a wrong belief `.repeat(3),
      ),
    }));
    model.srs.items = Array.from({ length: 200 }, (_, i) => ({
      concept: `concept-${i}`,
      topic: `topic-${i % 40}`,
      due: '2026-07-01',
      interval_days: 1,
      ease: 2.5,
      lapses: 0,
    }));

    const digest = formatStateDigest(model, { now: NOW });
    expect(estimateTokens(digest)).toBeLessThanOrEqual(STATE_DIGEST_TOKEN_BUDGET);
  });
});
