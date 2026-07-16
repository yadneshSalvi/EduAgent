import { describe, expect, it } from 'vitest';
import {
  masteryFileSchema,
  profileFrontmatterSchema,
  sessionLogFrontmatterSchema,
  srsQueueFileSchema,
  trackFileSchema,
} from '../src/index';

describe('profileFrontmatterSchema', () => {
  const valid = {
    name: 'Alex',
    goal: 'Pass backend engineer interviews by September 2026',
    tracks: ['sql-interview', 'python-dsa'],
    preferences: { session_length: 'short', style: 'socratic', humor: 'light' },
    timezone: 'America/Los_Angeles',
  };

  it('accepts the plans/02 §2.1 example', () => {
    const parsed = profileFrontmatterSchema.parse(valid);
    expect(parsed.name).toBe('Alex');
    expect(parsed.preferences.session_length).toBe('short');
  });

  it('defaults tracks/preferences/timezone when omitted', () => {
    const parsed = profileFrontmatterSchema.parse({ name: 'Sam', goal: 'Learn SQL' });
    expect(parsed.tracks).toEqual([]);
    expect(parsed.preferences).toEqual({});
    expect(parsed.timezone).toBe('UTC');
  });

  it('rejects a missing goal', () => {
    const { goal: _goal, ...rest } = valid;
    expect(profileFrontmatterSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an unknown preference enum value', () => {
    const bad = { ...valid, preferences: { ...valid.preferences, style: 'sarcastic' } };
    expect(profileFrontmatterSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-kebab-case track slugs', () => {
    const bad = { ...valid, tracks: ['SQL Interview'] };
    expect(profileFrontmatterSchema.safeParse(bad).success).toBe(false);
  });
});

describe('masteryFileSchema', () => {
  const valid = {
    topic: 'sql',
    display_name: 'SQL',
    updated: '2026-07-17T18:30:00Z',
    concepts: [
      {
        id: 'inner-join',
        name: 'INNER JOIN',
        mastery: 0.72,
        confidence: 'high',
        last_assessed: '2026-07-17',
        review_count: 3,
        prereqs: ['select-basics'],
        evidence: [
          { date: '2026-07-17', note: 'Solved ex-014 (medium) without hints' },
          { date: '2026-07-15', note: 'Confused INNER vs LEFT on quiz q-031' },
        ],
      },
    ],
  };

  it('accepts the plans/02 §2.2 example', () => {
    const parsed = masteryFileSchema.parse(valid);
    expect(parsed.concepts[0]?.mastery).toBe(0.72);
  });

  it('normalizes Date instances from YAML 1.1 parsers to ISO strings', () => {
    const fromYaml = {
      ...valid,
      updated: new Date('2026-07-17T18:30:00Z'),
      concepts: [
        {
          ...valid.concepts[0],
          last_assessed: new Date('2026-07-17T00:00:00Z'),
          evidence: [{ date: new Date('2026-07-17T00:00:00Z'), note: 'ok' }],
        },
      ],
    };
    const parsed = masteryFileSchema.parse(fromYaml);
    expect(parsed.updated).toBe('2026-07-17T18:30:00.000Z');
    expect(parsed.concepts[0]?.last_assessed).toBe('2026-07-17');
  });

  it('rejects mastery outside 0..1', () => {
    const bad = { ...valid, concepts: [{ ...valid.concepts[0], mastery: 1.2 }] };
    expect(masteryFileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a concept without evidence (every change needs an evidence entry)', () => {
    const bad = { ...valid, concepts: [{ ...valid.concepts[0], evidence: [] }] };
    expect(masteryFileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown confidence level', () => {
    const bad = { ...valid, concepts: [{ ...valid.concepts[0], confidence: 'certain' }] };
    expect(masteryFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe('trackFileSchema', () => {
  const valid = {
    track: 'sql-interview',
    display_name: 'SQL Interview Prep',
    target_date: '2026-09-01',
    items: [
      { concept: 'select-basics', topic: 'sql', weight: 1.0 },
      { concept: 'inner-join', topic: 'sql', weight: 1.5 },
    ],
  };

  it('accepts the plans/02 §2.4 example', () => {
    expect(trackFileSchema.parse(valid).items).toHaveLength(2);
  });

  it('accepts a missing target_date', () => {
    const { target_date: _t, ...rest } = valid;
    expect(trackFileSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects non-positive weights', () => {
    const bad = { ...valid, items: [{ concept: 'inner-join', topic: 'sql', weight: 0 }] };
    expect(trackFileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an empty curriculum', () => {
    expect(trackFileSchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });
});

describe('srsQueueFileSchema', () => {
  const valid = {
    items: [
      {
        concept: 'inner-join',
        topic: 'sql',
        due: '2026-07-20',
        interval_days: 3,
        ease: 2.5,
        lapses: 1,
      },
    ],
  };

  it('accepts the plans/02 §2.5 example', () => {
    expect(srsQueueFileSchema.parse(valid).items).toHaveLength(1);
  });

  it('defaults to an empty queue', () => {
    expect(srsQueueFileSchema.parse({}).items).toEqual([]);
  });

  it('rejects ease outside the SM-2 bounds [1.3, 2.8]', () => {
    const bad = { items: [{ ...valid.items[0], ease: 1.0 }] };
    expect(srsQueueFileSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects negative lapses', () => {
    const bad = { items: [{ ...valid.items[0], lapses: -1 }] };
    expect(srsQueueFileSchema.safeParse(bad).success).toBe(false);
  });
});

describe('sessionLogFrontmatterSchema', () => {
  const valid = {
    date: '2026-07-17',
    mode: 'learn',
    topics: ['sql'],
    duration_estimate: '25m',
    concepts_touched: ['inner-join', 'sql/left-join'],
    next_time: 'LEFT JOIN edge cases with NULLs',
  };

  it('accepts a full session log frontmatter', () => {
    const parsed = sessionLogFrontmatterSchema.parse(valid);
    expect(parsed.next_time).toBe('LEFT JOIN edge cases with NULLs');
  });

  it('accepts numeric duration and no next_time pointer', () => {
    const parsed = sessionLogFrontmatterSchema.parse({
      date: '2026-07-17',
      mode: 'onboarding',
      duration_estimate: 25,
    });
    expect(parsed.topics).toEqual([]);
    expect(parsed.next_time).toBeUndefined();
  });

  it('rejects an unknown mode', () => {
    expect(sessionLogFrontmatterSchema.safeParse({ ...valid, mode: 'cram' }).success).toBe(false);
  });

  it('rejects a malformed date', () => {
    expect(sessionLogFrontmatterSchema.safeParse({ ...valid, date: 'July 17' }).success).toBe(
      false,
    );
  });
});
