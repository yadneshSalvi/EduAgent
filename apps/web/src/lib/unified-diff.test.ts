import { describe, expect, it } from 'vitest';
import { languageForPath, parseUnifiedDiff } from './unified-diff';
import { GREETING_COMMIT, ONBOARDING_COMMIT } from './fixtures/turn-preview';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value');
  return value;
}

describe('parseUnifiedDiff', () => {
  it('splits the greeting-commit fixture into its three files', () => {
    const files = parseUnifiedDiff(GREETING_COMMIT.diff);
    expect(files.map((f) => f.path)).toEqual([
      'topics/sql/mastery.yaml',
      'topics/sql/misconceptions.md',
      'sessions/2026-07-17-sql.md',
    ]);
  });

  it('per-file insertion/deletion totals match the commit stats', () => {
    for (const commit of [GREETING_COMMIT, ONBOARDING_COMMIT]) {
      const files = parseUnifiedDiff(commit.diff);
      expect(files).toHaveLength(commit.stats.filesChanged);
      const insertions = files.reduce((n, f) => n + f.insertions, 0);
      const deletions = files.reduce((n, f) => n + f.deletions, 0);
      expect(insertions).toBe(commit.stats.insertions);
      expect(deletions).toBe(commit.stats.deletions);
    }
  });

  it('reconstructs original/modified sides from hunk lines', () => {
    const mastery = must(parseUnifiedDiff(GREETING_COMMIT.diff)[0]);
    expect(mastery.original).toContain('mastery: 0.40');
    expect(mastery.original).not.toContain('mastery: 0.72');
    expect(mastery.modified).toContain('mastery: 0.72');
    expect(mastery.modified).not.toContain('mastery: 0.40');
    // context lines land on both sides
    expect(mastery.original).toContain('name: INNER JOIN');
    expect(mastery.modified).toContain('name: INNER JOIN');
  });

  it('handles new files (/dev/null pre-image): empty original side', () => {
    const files = parseUnifiedDiff(ONBOARDING_COMMIT.diff);
    const profile = must(files.find((f) => f.path === 'profile.md'));
    expect(profile.original).toBe('');
    expect(profile.modified).toContain('# Alex');
  });

  it('separates multiple hunks with a same-on-both-sides gap row', () => {
    const diff = [
      'diff --git a/x.md b/x.md',
      'index 111..222 100644',
      '--- a/x.md',
      '+++ b/x.md',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+TWO',
      '@@ -10,2 +10,2 @@',
      ' ten',
      '-eleven',
      '+ELEVEN',
      '',
    ].join('\n');
    const file = must(parseUnifiedDiff(diff)[0]);
    expect(file.original.split('\n')).toEqual(['one', 'two', '···', 'ten', 'eleven']);
    expect(file.modified.split('\n')).toEqual(['one', 'TWO', '···', 'ten', 'ELEVEN']);
    expect(file.insertions).toBe(2);
    expect(file.deletions).toBe(2);
  });

  it('returns [] for an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
  });
});

describe('languageForPath', () => {
  it('maps learner-model file types to Monaco language ids', () => {
    expect(languageForPath('topics/sql/mastery.yaml')).toBe('yaml');
    expect(languageForPath('a.yml')).toBe('yaml');
    expect(languageForPath('profile.md')).toBe('markdown');
    expect(languageForPath('data.json')).toBe('json');
    expect(languageForPath('whatever.txt')).toBe('plaintext');
  });
});
