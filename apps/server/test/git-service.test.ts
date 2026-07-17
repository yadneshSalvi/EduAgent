import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_GIT_AUTHOR, GitService, parseCommit } from '../src/workspace/index.js';
import { createTestDataDir } from './helpers/test-workspace.js';

describe('parseCommit (plans/02 §3 grammar)', () => {
  it('parses the canonical learn example, deltas from the headline only', () => {
    const message = [
      'learn(sql): inner-join 0.40→0.72, left-join 0.20→0.40',
      '',
      '- Solved 2/3 join exercises without hints (ex-014 passed, ex-015 partial)',
      '- New misconception: believes WHERE filters before JOIN completes',
      '- Next: LEFT JOIN edge cases with NULLs',
    ].join('\n');
    const parsed = parseCommit(message);
    expect(parsed).toEqual({
      type: 'learn',
      topic: 'sql',
      headline: 'inner-join 0.40→0.72, left-join 0.20→0.40',
      bullets: [
        'Solved 2/3 join exercises without hints (ex-014 passed, ex-015 partial)',
        'New misconception: believes WHERE filters before JOIN completes',
        'Next: LEFT JOIN edge cases with NULLs',
      ],
      deltas: [
        { concept: 'inner-join', from: 0.4, to: 0.72 },
        { concept: 'left-join', from: 0.2, to: 0.4 },
      ],
    });
  });

  it('parses topic-less commits (profile, system)', () => {
    expect(parseCommit('profile: initialize learner model')).toEqual({
      type: 'profile',
      topic: null,
      headline: 'initialize learner model',
      bullets: [],
      deltas: [],
    });
    expect(parseCommit('system: initialize memory')?.type).toBe('system');
  });

  it('ignores delta-like text in body bullets', () => {
    const parsed = parseCommit(
      'review(sql): retrieval practice on joins\n\n- mastery inner-join 0.10→0.90 discussed',
    );
    expect(parsed?.deltas).toEqual([]);
    expect(parsed?.bullets).toHaveLength(1);
  });

  it('rejects unknown types and free-form messages', () => {
    expect(parseCommit('feat(sql): add join lesson')).toBeNull();
    expect(parseCommit('fixed stuff')).toBeNull();
    expect(parseCommit('learn: missing topic is fine though')).not.toBeNull();
  });

  it('drops out-of-range deltas instead of failing the parse', () => {
    const parsed = parseCommit('learn(sql): inner-join 9.99→0.50, left-join 0.20→0.40');
    expect(parsed?.deltas).toEqual([{ concept: 'left-join', from: 0.2, to: 0.4 }]);
  });
});

describe('GitService (real temp repo)', () => {
  let dir: string;
  let git: GitService;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const testEnv = createTestDataDir();
    cleanup = testEnv.cleanup;
    dir = path.join(testEnv.config.dataDir, 'repo');
    await fs.mkdir(dir, { recursive: true });
    git = new GitService(dir);
    await git.init();
  });

  afterEach(async () => {
    await cleanup();
  });

  async function write(relPath: string, content: string) {
    const abs = path.join(dir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  it('commitAll commits everything as the EduAgent author and returns the sha', async () => {
    await write('profile.md', 'hello');
    const sha = await git.commitAll('profile: initialize learner model');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const [head] = await git.log();
    expect(head?.sha).toBe(sha);
    expect(head?.authorName).toBe(AGENT_GIT_AUTHOR.name);
    expect(head?.authorEmail).toBe(AGENT_GIT_AUTHOR.email);
  });

  it('status reports dirty (incl. untracked) and clean states', async () => {
    await write('a.md', 'x');
    await git.commitAll('system: initialize memory');
    expect((await git.status()).isDirty).toBe(false);
    await write('b.md', 'y');
    const status = await git.status();
    expect(status.isDirty).toBe(true);
    expect(status.files).toContain('b.md');
  });

  it('log({from}) returns only commits after the marker, newest first, with full message', async () => {
    await write('a.md', '1');
    const base = await git.commitAll('system: initialize memory');
    await write('a.md', '2');
    await git.commitAll('learn(sql): first\n\n- bullet one');
    await write('a.md', '3');
    await git.commitAll('learn(sql): second');
    const commits = await git.log({ from: base });
    expect(commits.map((c) => c.message)).toEqual([
      'learn(sql): second',
      'learn(sql): first\n\n- bullet one',
    ]);
    expect(await git.log({ from: commits[0]!.sha })).toEqual([]);
  });

  it('log on an empty repo returns []', async () => {
    expect(await git.log()).toEqual([]);
    expect(await git.headSha()).toBeNull();
  });

  it('diffForCommit returns a unified diff and numstat totals (root commit included)', async () => {
    await write('topics/sql/mastery.yaml', 'topic: sql\n');
    const rootSha = await git.commitAll('system: initialize memory');
    const root = await git.diffForCommit(rootSha);
    expect(root.stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });

    await write('topics/sql/mastery.yaml', 'topic: sql\ndisplay_name: SQL\n');
    const sha = await git.commitAll('learn(sql): update');
    const { diff, stats } = await git.diffForCommit(sha);
    expect(diff).toContain('topics/sql/mastery.yaml');
    expect(diff).toContain('+display_name: SQL');
    expect(stats).toEqual({ filesChanged: 1, insertions: 1, deletions: 0 });
  });

  it('fileAtRef reads last-known-good content and returns null for unknown paths', async () => {
    await write('srs/queue.yaml', 'items: []\n');
    await git.commitAll('system: initialize memory');
    await write('srs/queue.yaml', 'items: [BROKEN');
    expect(await git.fileAtRef('HEAD', 'srs/queue.yaml')).toBe('items: []\n');
    expect(await git.fileAtRef('HEAD', 'nope.yaml')).toBeNull();
  });

  it('commitAll({backdate}) stamps author and committer dates', async () => {
    await write('a.md', 'x');
    const backdate = new Date('2026-06-01T12:00:00Z');
    await git.commitAll('seed(sql): backdated history', { backdate });
    const [head] = await git.log();
    expect(new Date(head!.date).toISOString()).toBe(backdate.toISOString());
  });

  it('lsFiles lists tracked paths', async () => {
    await write('topics/sql/mastery.yaml', 'topic: sql\n');
    await git.commitAll('system: initialize memory');
    expect(await git.lsFiles()).toContain('topics/sql/mastery.yaml');
  });
});
