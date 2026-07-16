import { describe, expect, it } from 'vitest';
import { MASTERY_DELTA_RE, MEMORY_COMMIT_HEADER_RE, parsedMemoryCommitSchema } from '../src/index';

describe('MEMORY_COMMIT_HEADER_RE', () => {
  it('parses the plans/02 §3 example header', () => {
    const m = 'learn(sql): inner-join 0.40→0.72, left-join 0.20→0.40'.match(
      MEMORY_COMMIT_HEADER_RE,
    );
    expect(m?.[1]).toBe('learn');
    expect(m?.[2]).toBe('sql');
    expect(m?.[3]).toBe('inner-join 0.40→0.72, left-join 0.20→0.40');
  });

  it('parses a topic-less header (profile: …)', () => {
    const m = 'profile: initialize learner model'.match(MEMORY_COMMIT_HEADER_RE);
    expect(m?.[1]).toBe('profile');
    expect(m?.[2]).toBeUndefined();
    expect(m?.[3]).toBe('initialize learner model');
  });

  it('does not match non-grammar messages', () => {
    expect('fix: typo'.match(MEMORY_COMMIT_HEADER_RE)).toBeNull();
    expect('learned(sql): something'.match(MEMORY_COMMIT_HEADER_RE)).toBeNull();
  });
});

describe('MASTERY_DELTA_RE', () => {
  it('extracts every conceptid A→B pair from a headline', () => {
    const headline = 'inner-join 0.40→0.72, left-join 0.20→0.40';
    const matches = [...headline.matchAll(MASTERY_DELTA_RE)];
    expect(matches).toHaveLength(2);
    expect(matches[0]?.slice(1)).toEqual(['inner-join', '0.40', '0.72']);
    expect(matches[1]?.slice(1)).toEqual(['left-join', '0.20', '0.40']);
  });
});

describe('parsedMemoryCommitSchema', () => {
  it('accepts a parsed learn commit', () => {
    const parsed = parsedMemoryCommitSchema.parse({
      type: 'learn',
      topic: 'sql',
      headline: 'inner-join 0.40→0.72',
      bullets: ['Solved 2/3 join exercises without hints (ex-014 passed, ex-015 partial)'],
      deltas: [{ concept: 'inner-join', from: 0.4, to: 0.72 }],
    });
    expect(parsed.type).toBe('learn');
  });

  it('accepts a null topic', () => {
    const parsed = parsedMemoryCommitSchema.parse({
      type: 'profile',
      topic: null,
      headline: 'initialize learner model',
      bullets: [],
      deltas: [],
    });
    expect(parsed.topic).toBeNull();
  });

  it('rejects an unknown commit type', () => {
    const result = parsedMemoryCommitSchema.safeParse({
      type: 'refactor',
      topic: 'sql',
      headline: 'x',
      bullets: [],
      deltas: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects deltas outside 0..1', () => {
    const result = parsedMemoryCommitSchema.safeParse({
      type: 'learn',
      topic: 'sql',
      headline: 'x',
      bullets: [],
      deltas: [{ concept: 'inner-join', from: 0.4, to: 1.4 }],
    });
    expect(result.success).toBe(false);
  });
});
