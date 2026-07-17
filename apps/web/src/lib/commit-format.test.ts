import { describe, expect, it } from 'vitest';
import { commitBadge, formatDelta, formatDiffStats, shortSha } from './commit-format';
import { formatMastery, masteryColor } from './mastery';
import { GREETING_COMMIT, ONBOARDING_COMMIT } from './fixtures/turn-preview';

describe('commit toast payload formatting', () => {
  it('commitBadge renders the commit grammar type(topic)', () => {
    expect(commitBadge(GREETING_COMMIT)).toBe('learn(sql)');
    expect(commitBadge({ type: 'exam', topic: 'python' })).toBe('exam(python)');
  });

  it('commitBadge drops the "(general)" fallback for topic-less commits', () => {
    expect(commitBadge(ONBOARDING_COMMIT)).toBe('profile');
  });

  it('formatDelta matches the commit-grammar delta form (02 §3)', () => {
    expect(formatDelta({ concept: 'inner-join', from: 0.4, to: 0.72 })).toBe(
      'inner-join 0.40→0.72',
    );
    // Round numbers keep two decimals — mono alignment depends on it.
    expect(formatDelta({ concept: 'group-by', from: 0, to: 1 })).toBe('group-by 0.00→1.00');
  });

  it('shortSha takes 7 chars', () => {
    expect(shortSha(GREETING_COMMIT.sha)).toBe('a3f8c21');
  });

  it('formatDiffStats pluralizes and signs correctly', () => {
    expect(formatDiffStats({ filesChanged: 3, insertions: 19, deletions: 8 })).toBe(
      '3 files · +19 −8',
    );
    expect(formatDiffStats({ filesChanged: 1, insertions: 0, deletions: 0 })).toBe(
      '1 file · +0 −0',
    );
  });
});

describe('mastery helpers', () => {
  it('formatMastery is always two decimals', () => {
    expect(formatMastery(0.4)).toBe('0.40');
    expect(formatMastery(1)).toBe('1.00');
  });

  it('masteryColor hits the ramp stops exactly and clamps out-of-range', () => {
    expect(masteryColor(0)).toBe('#2A2E3A');
    expect(masteryColor(0.25)).toBe('#3B4C6B');
    expect(masteryColor(0.5)).toBe('#2F6F8F');
    expect(masteryColor(0.75)).toBe('#2E9E7A');
    expect(masteryColor(1)).toBe('#3ECF8E');
    expect(masteryColor(-1)).toBe('#2A2E3A');
    expect(masteryColor(2)).toBe('#3ECF8E');
  });

  it('interpolates between stops', () => {
    // halfway between 0.75 (#2E9E7A) and 1.0 (#3ECF8E)
    expect(masteryColor(0.875)).toBe('#36B784');
  });
});
