import { describe, expect, it } from 'vitest';
import {
  commitBadge,
  commitToastDurationMs,
  DEFAULT_COMMIT_TOAST_MS,
  formatDelta,
  formatDiffStats,
  isLearnerVisibleCommit,
  shortSha,
} from './commit-format';
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

describe('isLearnerVisibleCommit (Phase 6 fix: examiner-only commits never toast)', () => {
  const empty = { stats: { filesChanged: 0, insertions: 0, deletions: 0 }, diff: '', deltas: [] };

  it('suppresses a commit whose visible diff was fully excluded (.exercises authoring)', () => {
    expect(isLearnerVisibleCommit(empty)).toBe(false);
    expect(isLearnerVisibleCommit({ ...empty, diff: '  \n' })).toBe(false);
  });

  it('keeps commits with visible files, diff text, or mastery deltas', () => {
    expect(
      isLearnerVisibleCommit({ ...empty, stats: { filesChanged: 2, insertions: 5, deletions: 1 } }),
    ).toBe(true);
    expect(isLearnerVisibleCommit({ ...empty, diff: 'diff --git a/x b/x' })).toBe(true);
    expect(
      isLearnerVisibleCommit({ ...empty, deltas: [{ concept: 'inner-join', from: 0.4, to: 0.7 }] }),
    ).toBe(true);
  });

  it('keeps the fixture commits (real learner-facing events)', () => {
    expect(isLearnerVisibleCommit(GREETING_COMMIT)).toBe(true);
    expect(isLearnerVisibleCommit(ONBOARDING_COMMIT)).toBe(true);
  });
});

describe('commitToastDurationMs (Phase 6 fix: 15s default, env-tunable)', () => {
  it('defaults to 15s', () => {
    expect(DEFAULT_COMMIT_TOAST_MS).toBe(15_000);
    expect(commitToastDurationMs(undefined)).toBe(15_000);
  });

  it('parses a valid override', () => {
    expect(commitToastDurationMs('20000')).toBe(20_000);
    expect(commitToastDurationMs('2500.9')).toBe(2500);
  });

  it('rejects junk and sub-second values', () => {
    expect(commitToastDurationMs('')).toBe(15_000);
    expect(commitToastDurationMs('fast')).toBe(15_000);
    expect(commitToastDurationMs('0')).toBe(15_000);
    expect(commitToastDurationMs('999')).toBe(15_000);
    expect(commitToastDurationMs('-4000')).toBe(15_000);
  });
});
