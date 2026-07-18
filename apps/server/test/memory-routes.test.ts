import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import {
  memoryDiffResponseSchema,
  memoryFileResponseSchema,
  memoryLogResponseSchema,
  memoryTreeResponseSchema,
  type MemoryTreeNode,
} from '@eduagent/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { safeRelPath } from '../src/api/memory.js';
import { loadConfig } from '../src/config.js';
import { createPrisma } from '../src/db.js';
import { GitService, WorkspaceManager } from '../src/workspace/index.js';
import { createTestDbUrl } from './helpers/test-db.js';
import { createTestDataDir } from './helpers/test-workspace.js';
import { FIXTURE_NOW, seedFixtureWorkspace, type FixtureRefs } from './helpers/fixture-workspace.js';

/**
 * Memory-explorer endpoints (plans/03 §7). The load-bearing rule under test:
 * COMMITTED content only — untracked/gitignored files (the hidden-test-leak
 * class) must be invisible to every route, and no query parameter may reach
 * git as anything but a validated ref or an in-repo path.
 */

let app: FastifyInstance;
let prisma: PrismaClient;
let workspaces: WorkspaceManager;
let cleanup: () => Promise<void>;
let cookie: string;
let userId: string;
let refs: FixtureRefs;
let workspaceDir: string;
/** Sha of the committed teach-skill evidence commit (examiner material). */
let authorSha: string;

/** Canary strings planted in COMMITTED examiner files — must never surface. */
const CANARY_SOLUTION = 'CANARY_SOLUTION_9f3e';
const CANARY_TESTS = 'CANARY_HIDDEN_TEST_7b2d';

async function get(url: string, withCookie = cookie) {
  return app.inject({ method: 'GET', url, headers: withCookie ? { cookie: withCookie } : {} });
}

function flatten(tree: MemoryTreeNode[]): string[] {
  return tree.flatMap((node) =>
    node.type === 'file' ? [node.path] : flatten(node.children ?? []),
  );
}

beforeAll(async () => {
  const databaseUrl = createTestDbUrl('memory-routes');
  prisma = createPrisma(databaseUrl);
  const dataDir = createTestDataDir();
  cleanup = dataDir.cleanup;
  workspaces = new WorkspaceManager(dataDir.config);
  app = await buildApp({
    config: loadConfig({
      NODE_ENV: 'test',
      AUTH_MODE: 'local',
      DATABASE_URL: databaseUrl,
      SESSION_SECRET: 'memory-routes-test-secret',
    }),
    prisma,
    services: { workspaces },
  });
  await app.ready();

  const login = await app.inject({
    method: 'POST',
    url: '/auth/local-login',
    payload: { handle: 'memory-user' },
  });
  expect(login.statusCode).toBe(200);
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
  userId = (login.json() as { id: string }).id;

  workspaceDir = workspaces.pathFor(userId);
  refs = await seedFixtureWorkspace(workspaceDir, FIXTURE_NOW);

  // Leak class 2 (QA F1): examiner material the teach skill COMMITS —
  // reference solution + hidden tests. The commit belongs on the timeline;
  // its contents must never leave through any memory endpoint.
  fs.mkdirSync(path.join(workspaceDir, '.exercises/ex-002/tests'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.exercises/ex-002/solution.sql'),
    `-- ${CANARY_SOLUTION}\nSELECT 42;\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(workspaceDir, '.exercises/ex-002/tests/test_hidden.py'),
    `# ${CANARY_TESTS}\nassert rows == 42\n`,
    'utf8',
  );
  authorSha = await new GitService(workspaceDir).commitAll(
    'system(sql): author ex-002 with hidden tests',
  );

  // Leak class 1: files ON DISK but never committed. `secret-notes.md` is
  // plain untracked; the hidden tests are the gitignored `.exercises` case.
  fs.writeFileSync(path.join(workspaceDir, 'secret-notes.md'), 'do not serve me', 'utf8');
  fs.mkdirSync(path.join(workspaceDir, '.exercises/ex-001/tests'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceDir, '.exercises/ex-001/tests/test_hidden.py'),
    'assert answer == 42',
    'utf8',
  );
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await cleanup();
});

describe('auth & ownership', () => {
  it('every route requires auth', async () => {
    for (const url of [
      '/api/memory/tree',
      '/api/memory/file?path=profile.md',
      '/api/memory/log',
      '/api/memory/diff?from=HEAD~1&to=HEAD',
      '/api/memory/export',
    ]) {
      const res = await get(url, '');
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('a user without a workspace sees no memory — never another user’s', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/local-login',
      payload: { handle: 'other-user' },
    });
    const otherCookie = String(login.headers['set-cookie']).split(';')[0]!;
    for (const url of ['/api/memory/tree', '/api/memory/file?path=profile.md', '/api/memory/export']) {
      const res = await get(url, otherCookie);
      expect(res.statusCode, url).toBe(404);
      expect((res.json() as { error: string }).error).toBe('no_memory');
    }
  });
});

describe('GET /api/memory/tree', () => {
  it('lists committed files only (dirs first), never untracked content', async () => {
    const res = await get('/api/memory/tree');
    expect(res.statusCode).toBe(200);
    const { tree } = memoryTreeResponseSchema.parse(res.json());
    const files = flatten(tree);
    expect(files).toContain('profile.md');
    expect(files).toContain('topics/sql/mastery.yaml');
    expect(files).toContain('srs/queue.yaml');
    expect(files).not.toContain('secret-notes.md');
    expect(files.some((f) => f.startsWith('.exercises/'))).toBe(false);
    // Directories sort before files at each level.
    expect(tree[0]!.type).toBe('dir');
    const topics = tree.find((n) => n.name === 'topics')!;
    expect(topics.children![0]!.name).toBe('sql');
  });
});

describe('GET /api/memory/file', () => {
  it('serves a committed file at HEAD by default', async () => {
    const res = await get('/api/memory/file?path=profile.md');
    expect(res.statusCode).toBe(200);
    const body = memoryFileResponseSchema.parse(res.json());
    expect(body.ref).toBe('HEAD');
    expect(body.content).toContain('name: Casey');
  });

  it('serves historical content at an explicit ref (time machine)', async () => {
    // At the first commit, mastery.yaml had no concepts yet.
    const res = await get(`/api/memory/file?path=topics/sql/mastery.yaml&ref=${refs.shas[0]}`);
    expect(res.statusCode).toBe(200);
    const body = memoryFileResponseSchema.parse(res.json());
    expect(body.content).toContain('concepts: []');
    const head = await get('/api/memory/file?path=topics/sql/mastery.yaml');
    expect((head.json() as { content: string }).content).toContain('select-basics');
  });

  it('denies files that exist on disk but are not committed (the leak rule)', async () => {
    expect(fs.existsSync(path.join(workspaceDir, 'secret-notes.md'))).toBe(true);
    const res = await get('/api/memory/file?path=secret-notes.md');
    expect(res.statusCode).toBe(404);
    const hidden = await get('/api/memory/file?path=.exercises/ex-001/tests/test_hidden.py');
    expect(hidden.statusCode).toBe(404);
  });

  it('rejects path traversal in all shapes', async () => {
    for (const bad of [
      '../../../etc/passwd',
      '..%2F..%2Fetc%2Fpasswd',
      '/etc/passwd',
      'topics/../../outside.md',
      'topics/..\\..\\x',
      '-flag-looking-path',
      'topics/-rf',
      '.',
    ]) {
      const res = await get(`/api/memory/file?path=${encodeURIComponent(bad)}`);
      expect([400, 404], bad).toContain(res.statusCode);
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('a normalized in-repo path is allowed (traversal that stays inside)', async () => {
    const res = await get(`/api/memory/file?path=${encodeURIComponent('topics/../profile.md')}`);
    expect(res.statusCode).toBe(200);
    expect((res.json() as { path: string }).path).toBe('profile.md');
  });

  it('rejects refs that are not HEAD/HEAD~N/main/sha (flag & range injection)', async () => {
    for (const bad of ['--help', 'main..HEAD', 'HEAD;id', 'HEAD --', 'refs/heads/main', '@{-1}']) {
      const res = await get(`/api/memory/file?path=profile.md&ref=${encodeURIComponent(bad)}`);
      expect(res.statusCode, bad).toBe(400);
    }
  });

  it('.git internals and directories are not blobs → 404', async () => {
    expect((await get('/api/memory/file?path=.git/config')).statusCode).toBe(404);
    expect((await get('/api/memory/file?path=topics')).statusCode).toBe(404);
    expect((await get('/api/memory/file?path=topics/sql')).statusCode).toBe(404);
  });
});

describe('GET /api/memory/log', () => {
  it('returns the parsed journal, newest first — examiner commits included', async () => {
    const res = await get('/api/memory/log');
    expect(res.statusCode).toBe(200);
    const { commits } = memoryLogResponseSchema.parse(res.json());
    expect(commits).toHaveLength(8);
    // The teach-skill evidence commit stays ON the journal (only its file
    // contents are excluded — QA F1).
    expect(commits[0]!.sha).toBe(authorSha);
    expect(commits[0]!.type).toBe('system');
    expect(commits[0]!.headline).toBe('author ex-002 with hidden tests');
    expect(commits[1]!.type).toBe('review');
    expect(commits.at(-1)!.type).toBe('profile');
    expect(commits[6]!.deltas).toEqual([{ concept: 'select-basics', from: 0.55, to: 0.8 }]);
  });

  it('narrows to one file with path (the explorer per-file rail)', async () => {
    const profile = memoryLogResponseSchema.parse(
      (await get('/api/memory/log?path=profile.md')).json(),
    );
    expect(profile.commits).toHaveLength(1);
    expect(profile.commits[0]!.sha).toBe(refs.shas[0]);

    const mastery = memoryLogResponseSchema.parse(
      (await get(`/api/memory/log?path=${encodeURIComponent('topics/sql/mastery.yaml')}`)).json(),
    );
    expect(mastery.commits).toHaveLength(5);
    expect(mastery.commits[0]!.type).toBe('learn');

    expect(
      (await get(`/api/memory/log?path=${encodeURIComponent('../outside')}`)).statusCode,
    ).toBe(400);
  });

  it('paginates with limit + skip', async () => {
    const page1 = memoryLogResponseSchema.parse((await get('/api/memory/log?limit=2')).json());
    const page2 = memoryLogResponseSchema.parse(
      (await get('/api/memory/log?limit=2&skip=2')).json(),
    );
    expect(page1.commits).toHaveLength(2);
    expect(page2.commits).toHaveLength(2);
    const all = memoryLogResponseSchema.parse((await get('/api/memory/log')).json());
    expect([...page1.commits, ...page2.commits].map((c) => c.sha)).toEqual(
      all.commits.slice(0, 4).map((c) => c.sha),
    );
  });
});

describe('GET /api/memory/diff', () => {
  it('diffs two refs with numstat totals', async () => {
    const res = await get(`/api/memory/diff?from=${refs.shas[0]}&to=${refs.shas[1]}`);
    expect(res.statusCode).toBe(200);
    const body = memoryDiffResponseSchema.parse(res.json());
    expect(body.diff).toContain('mastery.yaml');
    expect(body.diff).toContain('select-basics');
    expect(body.stats.filesChanged).toBe(2); // mastery.yaml + srs/queue.yaml
    expect(body.stats.insertions).toBeGreaterThan(0);
  });

  it('narrows to one path', async () => {
    const res = await get(
      `/api/memory/diff?from=${refs.shas[0]}&to=HEAD&path=${encodeURIComponent('topics/sql/mastery.yaml')}`,
    );
    const body = memoryDiffResponseSchema.parse(res.json());
    expect(body.stats.filesChanged).toBe(1);
    expect(body.diff).toContain('mastery.yaml');
    expect(body.diff).not.toContain('queue.yaml');
  });

  it('rejects invalid refs and paths', async () => {
    expect((await get('/api/memory/diff?from=--help&to=HEAD')).statusCode).toBe(400);
    expect((await get('/api/memory/diff?from=HEAD&to=HEAD~1;id')).statusCode).toBe(400);
    expect(
      (await get(`/api/memory/diff?from=HEAD~1&to=HEAD&path=${encodeURIComponent('../x')}`))
        .statusCode,
    ).toBe(400);
  });

  it('404s on an unknown sha', async () => {
    expect((await get('/api/memory/diff?from=deadbeef&to=HEAD')).statusCode).toBe(404);
  });

  it('accepts the empty-tree sha (the web root-commit diff idiom)', async () => {
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const res = await get(`/api/memory/diff?from=${emptyTree}&to=${refs.shas[0]}`);
    expect(res.statusCode).toBe(200);
    const body = memoryDiffResponseSchema.parse(res.json());
    expect(body.stats.filesChanged).toBe(5); // the root commit's whole tree
    expect(body.diff).toContain('profile.md');
    expect(body.stats.deletions).toBe(0);
  });
});

describe('GET /api/memory/export', () => {
  it('streams a zip of exactly the committed tree', async () => {
    const res = await get('/api/memory/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(String(res.headers['content-disposition'])).toContain('eduagent-memory-');
    const zip = res.rawPayload;
    expect(zip.subarray(0, 2).toString('latin1')).toBe('PK'); // zip magic
    // Listing via bsdtar (reads zip archives on macOS/Linux).
    const zipPath = path.join(path.dirname(workspaceDir), 'export-under-test.zip');
    fs.writeFileSync(zipPath, zip);
    const listing = execFileSync('tar', ['-tf', zipPath]).toString();
    expect(listing).toContain('profile.md');
    expect(listing).toContain('topics/sql/mastery.yaml');
    expect(listing).not.toContain('secret-notes.md');
    expect(listing).not.toContain('.exercises');
    expect(listing).not.toContain('.git/');
  });
});

describe('committed examiner material (QA F1)', () => {
  it('tree hides .exercises even though it is committed', async () => {
    const { tree } = memoryTreeResponseSchema.parse((await get('/api/memory/tree')).json());
    const files = flatten(tree);
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.startsWith('.exercises'))).toBe(false);
  });

  it('file 404s for committed solution/tests at HEAD and at the author sha', async () => {
    for (const url of [
      '/api/memory/file?path=.exercises%2Fex-002%2Fsolution.sql',
      '/api/memory/file?path=.exercises%2Fex-002%2Ftests%2Ftest_hidden.py',
      `/api/memory/file?path=.exercises%2Fex-002%2Fsolution.sql&ref=${authorSha}`,
      // Traversal that normalizes back INTO the examiner dir.
      `/api/memory/file?path=${encodeURIComponent('topics/../.exercises/ex-002/solution.sql')}`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect((res.json() as { error: string }).error, url).toBe('not_found');
    }
  });

  it('log with an examiner path behaves like a path that never existed', async () => {
    const res = await get(
      `/api/memory/log?path=${encodeURIComponent('.exercises/ex-002/solution.sql')}`,
    );
    expect(res.statusCode).toBe(200);
    expect(memoryLogResponseSchema.parse(res.json()).commits).toEqual([]);
  });

  it('the author commit diffs as empty — commit visible, contents not', async () => {
    const res = await get(`/api/memory/diff?from=${refs.shas.at(-1)}&to=${authorSha}`);
    expect(res.statusCode).toBe(200);
    const body = memoryDiffResponseSchema.parse(res.json());
    expect(body.diff).toBe('');
    expect(body.stats).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 });
  });

  it('diff narrowed to an examiner path is empty too', async () => {
    const res = await get(
      `/api/memory/diff?from=${refs.shas[0]}&to=HEAD&path=${encodeURIComponent('.exercises/ex-002/solution.sql')}`,
    );
    expect(res.statusCode).toBe(200);
    const body = memoryDiffResponseSchema.parse(res.json());
    expect(body.diff).toBe('');
    expect(body.stats.filesChanged).toBe(0);
  });

  it('leak hunt: no endpoint response ever contains examiner content', async () => {
    const emptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const urls = [
      '/api/memory/tree',
      '/api/memory/log',
      '/api/memory/log?limit=500',
      `/api/memory/log?path=${encodeURIComponent('.exercises/ex-002/solution.sql')}`,
      '/api/memory/file?path=.exercises%2Fex-002%2Fsolution.sql',
      `/api/memory/file?path=.exercises%2Fex-002%2Ftests%2Ftest_hidden.py&ref=${authorSha}`,
      `/api/memory/diff?from=${emptyTree}&to=HEAD`,
      `/api/memory/diff?from=${refs.shas.at(-1)}&to=HEAD`,
      `/api/memory/diff?from=${refs.shas.at(-1)}&to=${authorSha}`,
      `/api/memory/diff?from=${emptyTree}&to=${authorSha}`,
      `/api/memory/diff?from=${refs.shas[0]}&to=HEAD&path=${encodeURIComponent('.exercises/ex-002/solution.sql')}`,
    ];
    for (const url of urls) {
      const res = await get(url);
      expect(res.body, url).not.toContain(CANARY_SOLUTION);
      expect(res.body, url).not.toContain(CANARY_TESTS);
      expect(res.body, url).not.toContain('SELECT 42');
      expect(res.body, url).not.toContain('assert rows');
    }

    // Export: extract the zip and scan every file it actually contains.
    const res = await get('/api/memory/export');
    expect(res.statusCode).toBe(200);
    const extractDir = path.join(path.dirname(workspaceDir), 'export-leak-hunt');
    fs.mkdirSync(extractDir, { recursive: true });
    const zipPath = path.join(extractDir, 'export.zip');
    fs.writeFileSync(zipPath, res.rawPayload);
    execFileSync('tar', ['-xf', zipPath, '-C', extractDir]);
    const scan = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          expect(entry.name, abs).not.toBe('.exercises');
          scan(abs);
        } else if (entry.name !== 'export.zip') {
          const content = fs.readFileSync(abs, 'utf8');
          expect(content, abs).not.toContain(CANARY_SOLUTION);
          expect(content, abs).not.toContain(CANARY_TESTS);
        }
      }
    };
    scan(extractDir);
  });
});

describe('safeRelPath (unit)', () => {
  it('normalizes safe paths and rejects escapes', () => {
    expect(safeRelPath('profile.md')).toBe('profile.md');
    expect(safeRelPath('topics/sql/mastery.yaml')).toBe('topics/sql/mastery.yaml');
    expect(safeRelPath('topics/../profile.md')).toBe('profile.md');
    expect(safeRelPath('../outside')).toBeNull();
    expect(safeRelPath('a/../../outside')).toBeNull();
    expect(safeRelPath('/absolute')).toBeNull();
    expect(safeRelPath('back\\slash')).toBeNull();
    expect(safeRelPath('-starts-with-dash')).toBeNull();
    expect(safeRelPath('dir/-dash-segment')).toBeNull();
    expect(safeRelPath('.')).toBeNull();
    expect(safeRelPath('nul\0byte')).toBeNull();
  });
});
