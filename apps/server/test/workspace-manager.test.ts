import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/config.js';
import { WorkspaceManager, WORKSPACE_INIT_COMMIT } from '../src/workspace/index.js';
import { createTestDataDir } from './helpers/test-workspace.js';

const USER = 'user-test-1';

const PROFILE_MD = `---
name: Alex
goal: Pass backend engineer interviews by September 2026
tracks: [sql-interview]
preferences:
  session_length: short
  style: socratic
timezone: America/Los_Angeles
---

Alex is a mid-level frontend dev moving to backend.
`;

const MASTERY_YAML = `topic: sql
display_name: SQL
updated: 2026-07-17T18:30:00Z
concepts:
  - id: inner-join
    name: INNER JOIN
    mastery: 0.72
    confidence: high
    last_assessed: 2026-07-17
    review_count: 3
    prereqs: [select-basics]
    evidence:
      - date: 2026-07-17
        note: "Solved ex-014 (medium) without hints"
`;

const TRACK_YAML = `track: sql-interview
display_name: SQL Interview Prep
target_date: 2026-09-01
items:
  - concept: inner-join
    topic: sql
    weight: 1.5
`;

const MISCONCEPTIONS_MD = `## [OPEN] Believes WHERE filters before JOIN completes
- first_seen: 2026-07-15 · concepts: [inner-join, where-clause]

## [RESOLVED 2026-07-17] Thought PRIMARY KEY implies index ordering
`;

const SESSION_MD = `---
date: 2026-07-16
mode: learn
topics: [sql]
duration_estimate: 25m
concepts_touched: [inner-join]
next_time: LEFT JOIN edge cases with NULLs
---

Worked through INNER vs LEFT JOIN.
`;

describe('WorkspaceManager', () => {
  let config: AppConfig;
  let cleanup: () => Promise<void>;
  let manager: WorkspaceManager;

  beforeEach(() => {
    ({ config, cleanup } = createTestDataDir());
    manager = new WorkspaceManager(config);
  });

  afterEach(async () => {
    await cleanup();
  });

  async function write(relPath: string, content: string) {
    const abs = path.join(manager.pathFor(USER), relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }

  async function populateAndCommit() {
    await write('profile.md', PROFILE_MD);
    await write('topics/sql/mastery.yaml', MASTERY_YAML);
    await write('topics/sql/misconceptions.md', MISCONCEPTIONS_MD);
    await write('tracks/sql-interview/track.yaml', TRACK_YAML);
    await write('sessions/2026-07-16-sql-joins.md', SESSION_MD);
    await manager.git(USER).commitAll('learn(sql): populate fixtures');
  }

  describe('ensureWorkspace', () => {
    it('creates the template files and the system: initialize memory commit', async () => {
      const result = await manager.ensureWorkspace(USER);
      expect(result.created).toBe(true);
      expect(result.path).toBe(path.join(config.dataDir, 'workspaces', USER));

      const readme = await fs.readFile(path.join(result.path, 'README.md'), 'utf8');
      expect(readme).toContain('your memory');
      await fs.access(path.join(result.path, '.gitignore'));
      await fs.access(path.join(result.path, 'srs', 'queue.yaml'));
      await fs.access(path.join(result.path, '.exercises', '.gitkeep'));

      const log = await manager.git(USER).log();
      expect(log).toHaveLength(1);
      expect(log[0]?.message).toBe(WORKSPACE_INIT_COMMIT);
      expect(log[0]?.authorEmail).toBe('agent@eduagent.local');
      expect((await manager.git(USER).status()).isDirty).toBe(false);
    });

    it('is idempotent, including under concurrent calls', async () => {
      // Concurrent callers share one in-flight creation (both see its result).
      const [a, b] = await Promise.all([
        manager.ensureWorkspace(USER),
        manager.ensureWorkspace(USER),
      ]);
      expect(a.created && b.created).toBe(true);
      const again = await manager.ensureWorkspace(USER);
      expect(again.created).toBe(false);
      expect(await manager.git(USER).log()).toHaveLength(1);
    });

    it('rejects user ids that could escape the data dir', () => {
      expect(() => manager.pathFor('../evil')).toThrow(/invalid userId/);
    });
  });

  describe('readLearnerModel', () => {
    it('returns an empty-but-valid model for a fresh workspace', async () => {
      await manager.ensureWorkspace(USER);
      const model = await manager.readLearnerModel(USER);
      expect(model.profile).toBeNull();
      expect(model.tracks).toEqual([]);
      expect(model.topics).toEqual([]);
      expect(model.srs).toEqual({ items: [] });
      expect(model.lastSession).toBeNull();
      expect(model.needsRepair).toEqual([]);
    });

    it('parses all populated files', async () => {
      await manager.ensureWorkspace(USER);
      await populateAndCommit();
      const model = await manager.readLearnerModel(USER);

      expect(model.profile?.frontmatter.name).toBe('Alex');
      expect(model.profile?.frontmatter.preferences.style).toBe('socratic');
      expect(model.tracks.map((t) => t.track)).toEqual(['sql-interview']);
      expect(model.topics).toHaveLength(1);
      expect(model.topics[0]?.displayName).toBe('SQL');
      expect(model.topics[0]?.mastery?.concepts[0]?.id).toBe('inner-join');
      expect(model.topics[0]?.openMisconceptions).toEqual([
        'Believes WHERE filters before JOIN completes',
      ]);
      expect(model.lastSession?.frontmatter.next_time).toBe('LEFT JOIN edge cases with NULLs');
      expect(model.needsRepair).toEqual([]);
    });

    it('falls back to last-known-good and flags needsRepair on corrupted YAML', async () => {
      await manager.ensureWorkspace(USER);
      await populateAndCommit();
      await write('topics/sql/mastery.yaml', 'topic: [unclosed\n  nonsense: {{{{');

      const model = await manager.readLearnerModel(USER);
      expect(model.needsRepair).toContain('topics/sql/mastery.yaml');
      // Value comes from HEAD, not the broken disk copy.
      expect(model.topics[0]?.mastery?.concepts[0]?.id).toBe('inner-join');
    });

    it('flags schema-invalid (but parseable) YAML too', async () => {
      await manager.ensureWorkspace(USER);
      await populateAndCommit();
      // mastery outside 0..1 violates the shared schema.
      await write('topics/sql/mastery.yaml', MASTERY_YAML.replace('mastery: 0.72', 'mastery: 7.2'));
      const model = await manager.readLearnerModel(USER);
      expect(model.needsRepair).toContain('topics/sql/mastery.yaml');
      expect(model.topics[0]?.mastery?.concepts[0]?.mastery).toBe(0.72);
    });

    it('returns null value but flags repair when no good version exists anywhere', async () => {
      await manager.ensureWorkspace(USER);
      await write('topics/sql/mastery.yaml', 'never: valid');
      const model = await manager.readLearnerModel(USER);
      expect(model.needsRepair).toContain('topics/sql/mastery.yaml');
      expect(model.topics[0]?.mastery).toBeNull();
    });

    it('recovers a deleted tracked file from HEAD and flags it', async () => {
      await manager.ensureWorkspace(USER);
      await populateAndCommit();
      await fs.rm(path.join(manager.pathFor(USER), 'tracks', 'sql-interview', 'track.yaml'));
      const model = await manager.readLearnerModel(USER);
      expect(model.needsRepair).toContain('tracks/sql-interview/track.yaml');
      expect(model.tracks.map((t) => t.track)).toEqual(['sql-interview']);
    });
  });

  describe('stateDigest', () => {
    it('summarizes a populated workspace', async () => {
      await manager.ensureWorkspace(USER);
      await populateAndCommit();
      const digest = await manager.stateDigest(USER, { now: new Date('2026-07-18T00:00:00Z') });
      expect(digest).toContain('[LEARNER STATE 2026-07-18]');
      expect(digest).toContain('Learner: Alex');
      expect(digest).toContain('sql/inner-join');
      expect(digest).toContain('next time: LEFT JOIN edge cases with NULLs');
    });
  });

  describe('ensureSkillsInstalled', () => {
    it('installs both skills under $DATA_DIR/.codex/skills, idempotently', async () => {
      const first = await manager.ensureSkillsInstalled();
      expect(first.map((r) => `${r.name}:${r.action}`).sort()).toEqual([
        'memory:installed',
        'teach:installed',
      ]);
      for (const skill of ['teach', 'memory']) {
        const installed = await fs.readFile(
          path.join(config.dataDir, '.codex', 'skills', skill, 'SKILL.md'),
          'utf8',
        );
        expect(installed.startsWith('---\n')).toBe(true);
        expect(installed).toContain(`name: ${skill}`);
        expect(installed).toContain('description:');
      }

      const second = await manager.ensureSkillsInstalled();
      expect(second.every((r) => r.action === 'unchanged')).toBe(true);
    });

    it('overwrites a drifted installed copy (content-hash mismatch)', async () => {
      await manager.ensureSkillsInstalled();
      const target = path.join(config.dataDir, '.codex', 'skills', 'teach', 'SKILL.md');
      await fs.writeFile(target, 'tampered', 'utf8');
      const results = await manager.ensureSkillsInstalled();
      expect(results.find((r) => r.name === 'teach')?.action).toBe('updated');
      expect(await fs.readFile(target, 'utf8')).not.toBe('tampered');
    });
  });
});
