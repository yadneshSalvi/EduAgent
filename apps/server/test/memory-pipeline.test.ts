import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { WsEventOf } from '@eduagent/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { MemoryPipeline, WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';

const USER = 'user-pipe-1';
const THREAD = 'thread-1';

const MASTERY_YAML = `topic: sql
display_name: SQL
updated: 2026-07-17T18:30:00Z
concepts:
  - id: inner-join
    name: INNER JOIN
    mastery: 0.72
    confidence: medium
    last_assessed: 2026-07-17
    review_count: 1
    prereqs: []
    evidence:
      - date: 2026-07-17
        note: "Solved ex-014"
`;

describe('MemoryPipeline (real temp repo + real test db)', () => {
  let config: AppConfig;
  let cleanup: () => Promise<void>;
  let prisma: PrismaClient;
  let workspaces: WorkspaceManager;
  let pipeline: MemoryPipeline;
  let emitted: Array<{ userId: string; event: WsEventOf<'memory.commit'> }>;
  let invalidated: string[];
  let warnings: Array<Record<string, unknown>>;

  beforeEach(async () => {
    ({ config, cleanup } = createTestDataDir());
    prisma = createPrisma(createTestDbUrl('memory-pipeline'));
    workspaces = new WorkspaceManager(config);
    emitted = [];
    invalidated = [];
    warnings = [];
    pipeline = new MemoryPipeline({
      workspaces,
      prisma,
      emitter: { emitToUser: (userId, event) => emitted.push({ userId, event }) },
      onMemoryChanged: (userId) => invalidated.push(userId),
      logger: {
        info: () => {},
        warn: (obj) => warnings.push(obj as Record<string, unknown>),
      },
    });
    await prisma.user.create({
      data: {
        id: USER,
        handle: 'pipe-tester',
        displayName: 'Pipe Tester',
        workspacePath: workspaces.pathFor(USER),
      },
    });
    await workspaces.ensureWorkspace(USER);
  });

  afterEach(async () => {
    await prisma.$disconnect();
    await cleanup();
  });

  async function write(relPath: string, content: string) {
    const abs = path.join(workspaces.pathFor(USER), relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  it('parses agent commits into memory.commit events + ActivityEvent rows', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);

    // Simulate the agent's work during a turn: edit + commit per the grammar.
    await write('topics/sql/mastery.yaml', MASTERY_YAML);
    await workspaces
      .git(USER)
      .commitAll('learn(sql): inner-join 0.40→0.72\n\n- Solved ex-014 without hints');

    const events = await pipeline.afterTurn({
      userId: USER,
      threadId: THREAD,
      topicSlug: 'sql',
      sinceSha,
    });

    expect(events).toHaveLength(1);
    const commit = events[0]!;
    expect(commit.type).toBe('learn');
    expect(commit.topic).toBe('sql');
    expect(commit.headline).toBe('inner-join 0.40→0.72');
    expect(commit.deltas).toEqual([{ concept: 'inner-join', from: 0.4, to: 0.72 }]);
    expect(commit.bullets).toEqual(['Solved ex-014 without hints']);
    expect(commit.stats).toEqual({ filesChanged: 1, insertions: 14, deletions: 0 });
    expect(commit.diff).toContain('topics/sql/mastery.yaml');
    expect(commit.sha).toMatch(/^[0-9a-f]{40}$/);

    expect(emitted).toEqual([{ userId: USER, event: { type: 'memory.commit', commit } }]);
    expect(invalidated).toEqual([USER]);
    expect(warnings).toEqual([]);

    const rows = await prisma.activityEvent.findMany({ where: { userId: USER } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('commit');
    expect(rows[0]?.meta).toMatchObject({
      threadId: THREAD,
      sha: commit.sha,
      type: 'learn',
      topic: 'sql',
      headline: 'inner-join 0.40→0.72',
    });
  });

  it('checkpoints a dirty workspace with a prompt-bug warning', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);
    await write('topics/sql/mastery.yaml', MASTERY_YAML); // agent forgot to commit

    const events = await pipeline.afterTurn({
      userId: USER,
      threadId: THREAD,
      topicSlug: 'sql',
      sinceSha,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'system',
      topic: 'sql',
      headline: 'checkpoint memory',
    });
    expect(warnings.some((w) => w.tag === 'prompt-bug')).toBe(true);
    expect((await workspaces.git(USER).status()).isDirty).toBe(false);
  });

  it('falls back to the "general" topic for topic-less checkpoint commits', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);
    await write('notes.md', 'dangling change');
    const events = await pipeline.afterTurn({ userId: USER, threadId: THREAD, sinceSha });
    expect(events[0]).toMatchObject({ type: 'system', topic: 'general' });
  });

  it('emits nothing and skips invalidation when the turn touched no memory', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);
    const events = await pipeline.afterTurn({
      userId: USER,
      threadId: THREAD,
      topicSlug: 'sql',
      sinceSha,
    });
    expect(events).toEqual([]);
    expect(emitted).toEqual([]);
    expect(invalidated).toEqual([]);
    expect(await prisma.activityEvent.count()).toBe(0);
  });

  it('returns multiple commits oldest-first', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);
    const git = workspaces.git(USER);
    await write('topics/sql/mastery.yaml', MASTERY_YAML);
    await git.commitAll('learn(sql): inner-join 0.40→0.72');
    await write('topics/sql/misconceptions.md', '## [OPEN] Believes WHERE runs before JOIN\n');
    await git.commitAll('misconception(sql): opened "WHERE runs before JOIN"');

    const events = await pipeline.afterTurn({
      userId: USER,
      threadId: THREAD,
      topicSlug: 'sql',
      sinceSha,
    });
    expect(events.map((e) => e.type)).toEqual(['learn', 'misconception']);
    expect(invalidated).toEqual([USER]);
    expect(await prisma.activityEvent.count()).toBe(2);
  });

  it('reuses emitCommits for an out-of-turn server plan commit', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);
    await write('tracks/sql-interview/roadmap.yaml', 'track: sql-interview\n');
    await workspaces.git(USER).commitAll('plan(sql-interview): day 3 complete — CTEs');

    const events = await pipeline.emitCommits(USER, sinceSha);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'plan', topic: 'sql-interview' });
    expect(emitted).toHaveLength(1);
    const row = await prisma.activityEvent.findFirstOrThrow({ where: { userId: USER } });
    expect(row.meta).toMatchObject({ type: 'plan', topic: 'sql-interview' });
    expect(row.meta).not.toHaveProperty('threadId');
    expect(invalidated).toEqual([USER]);
  });

  it('broadcasts non-grammar commits as system type with a prompt-bug warning', async () => {
    const sinceSha = await pipeline.beforeTurn(USER);
    await write('scratch.md', 'x');
    await workspaces.git(USER).commitAll('did some stuff');

    const events = await pipeline.afterTurn({
      userId: USER,
      threadId: THREAD,
      topicSlug: 'sql',
      sinceSha,
    });
    expect(events[0]).toMatchObject({
      type: 'system',
      topic: 'general',
      headline: 'did some stuff',
    });
    expect(warnings.some((w) => w.tag === 'prompt-bug')).toBe(true);
  });

  it('warns when the pre-turn HEAD was rewritten out of history (.git tamper telemetry)', async () => {
    const git = workspaces.git(USER);
    await write('topics/sql/mastery.yaml', MASTERY_YAML);
    await git.commitAll('learn(sql): inner-join 0.40→0.72');
    const sinceSha = await pipeline.beforeTurn(USER);

    // Simulate an agent rewriting its ledger mid-turn: drop the pre-turn HEAD
    // and commit something else in its place.
    execSync(`git -C ${workspaces.pathFor(USER)} reset --hard HEAD~1`);
    await write('topics/sql/mastery.yaml', MASTERY_YAML.replace('0.72', '0.99'));
    await git.commitAll('learn(sql): inner-join 0.40→0.99');

    await pipeline.afterTurn({ userId: USER, threadId: THREAD, topicSlug: 'sql', sinceSha });
    expect(warnings.some((w) => w.tag === 'memory-history-rewritten')).toBe(true);
  });
});
