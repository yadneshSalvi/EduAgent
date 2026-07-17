import path from 'node:path';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  memoryDiffQuerySchema,
  memoryFileQuerySchema,
  memoryLogQuerySchema,
  type MemoryDiffResponse,
  type MemoryFileResponse,
  type MemoryLogResponse,
  type MemoryTreeNode,
  type MemoryTreeResponse,
  type TimelineEntry,
} from '@eduagent/shared';
import { parseCommit } from '../workspace/GitService.js';
import type { GitService } from '../workspace/GitService.js';
import { sendError } from './http.js';

/**
 * Memory explorer + time machine (plans/03 §7, plans/04 §7). THE serving
 * rule: git-tracked, COMMITTED content only. Every byte leaves via a git
 * object read (`cat-file`/`ls-tree`/`diff`/`archive`) — the working tree is
 * never touched, so untracked/gitignored files (e.g. `.exercises/` hidden
 * tests that haven't been committed) can never leak, regardless of what the
 * path resolves to on disk.
 *
 * Ownership: every route resolves the authed user and only ever opens THAT
 * user's workspace repo — there is no cross-user parameter anywhere.
 */

/**
 * Refs the explorer accepts: HEAD (optionally with ~N), the main branch, or
 * an abbreviated/full hex sha (the time machine scrubs the parsed log). The
 * allowlist doubles as flag-injection protection — nothing here can start
 * with `-` or smuggle range/path syntax.
 */
const REF_RE = /^(HEAD(~\d{1,4})?|main|[0-9a-fA-F]{4,40})$/;

const refSchema = z.string().regex(REF_RE, 'expected HEAD, HEAD~N, main, or a commit sha');

/**
 * Normalizes a workspace-relative path and rejects anything that could
 * escape or alias the repo (traversal, absolute, backslashes, `-` prefixes).
 * Returns null on rejection; the normalized result is what goes into the
 * `ref:path` spec.
 */
export function safeRelPath(input: string): string | null {
  if (input.includes('\\') || input.includes('\0') || input.length > 512) return null;
  const normalized = path.posix.normalize(input);
  if (normalized === '.' || normalized.startsWith('/') || normalized.startsWith('..')) return null;
  const segments = normalized.split('/');
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..' || seg.startsWith('-'))) {
    return null;
  }
  return normalized;
}

/** Nests flat tracked paths into the shared MemoryTreeNode shape (dirs first). */
export function buildTree(paths: string[]): MemoryTreeNode[] {
  interface MutableNode extends MemoryTreeNode {
    children?: MutableNode[];
    childIndex?: Map<string, MutableNode>;
  }
  const root: MutableNode[] = [];
  const rootIndex = new Map<string, MutableNode>();
  for (const relPath of [...paths].sort()) {
    let level = root;
    let levelIndex = rootIndex;
    const segments = relPath.split('/');
    segments.forEach((name, i) => {
      const isFile = i === segments.length - 1;
      const nodePath = segments.slice(0, i + 1).join('/');
      let node = levelIndex.get(name);
      if (!node) {
        node = isFile
          ? { name, path: nodePath, type: 'file' }
          : { name, path: nodePath, type: 'dir', children: [], childIndex: new Map() };
        level.push(node);
        levelIndex.set(name, node);
      }
      if (!isFile) {
        level = node.children!;
        levelIndex = node.childIndex!;
      }
    });
  }
  const finalize = (nodes: MutableNode[]): MemoryTreeNode[] =>
    nodes
      .sort((a, b) => Number(b.type === 'dir') - Number(a.type === 'dir') || a.name.localeCompare(b.name))
      .map((node) => ({
        name: node.name,
        path: node.path,
        type: node.type,
        ...(node.children ? { children: finalize(node.children) } : {}),
      }));
  return finalize(root);
}

/** Local pagination extension: the shared schema fixes limit; skip is additive. */
const logQueryExtraSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
});

export const memoryRoutes: FastifyPluginAsync = async (app) => {
  /** Authed user's GitService, or null after replying (401 / empty-workspace 404). */
  const ownedGit = async (
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ git: GitService; userId: string } | null> => {
    const authed = await app.resolveUser(req);
    if (!authed) {
      await sendError(reply, 401, 'unauthenticated');
      return null;
    }
    if (!app.workspaces) {
      await sendError(reply, 503, 'not_ready', 'The workspace service has not finished booting.');
      return null;
    }
    if (!app.workspaces.hasWorkspace(authed.userId)) {
      await sendError(reply, 404, 'no_memory', 'This learner has no memory workspace yet.');
      return null;
    }
    return { git: app.workspaces.git(authed.userId), userId: authed.userId };
  };

  app.get('/api/memory/tree', async (req, reply) => {
    const owned = await ownedGit(req, reply);
    if (!owned) return reply;
    const response: MemoryTreeResponse = { tree: buildTree(await owned.git.lsTree('HEAD')) };
    return response;
  });

  app.get('/api/memory/file', async (req, reply) => {
    const owned = await ownedGit(req, reply);
    if (!owned) return reply;
    const query = memoryFileQuerySchema.safeParse(req.query);
    if (!query.success) {
      return sendError(reply, 400, 'invalid_query', formatIssues(query.error.issues));
    }
    const relPath = safeRelPath(query.data.path);
    if (relPath === null) {
      return sendError(reply, 400, 'invalid_path', 'Not a workspace-relative file path.');
    }
    const ref = query.data.ref ?? 'HEAD';
    if (!refSchema.safeParse(ref).success) {
      return sendError(reply, 400, 'invalid_ref', 'Expected HEAD, HEAD~N, main, or a commit sha.');
    }
    const content = await owned.git.blobAtRef(ref, relPath);
    if (content === null) {
      return sendError(reply, 404, 'not_found', `No committed file "${relPath}" at ${ref}.`);
    }
    const response: MemoryFileResponse = { path: relPath, ref, content };
    return response;
  });

  app.get('/api/memory/log', async (req, reply) => {
    const owned = await ownedGit(req, reply);
    if (!owned) return reply;
    const query = memoryLogQuerySchema.safeParse(req.query);
    const extra = logQueryExtraSchema.safeParse(req.query);
    if (!query.success || !extra.success) {
      const issues = [...(query.success ? [] : query.error.issues), ...(extra.success ? [] : extra.error.issues)];
      return sendError(reply, 400, 'invalid_query', formatIssues(issues));
    }
    const limit = query.data.limit ?? 100;
    const log = await owned.git.log({ maxCount: extra.data.skip + limit });
    const commits: TimelineEntry[] = log.slice(extra.data.skip).map((info) => {
      const parsed = parseCommit(info.message);
      const instantMs = Date.parse(info.date);
      return {
        sha: info.sha,
        type: parsed?.type ?? 'system',
        topic: parsed?.topic ?? 'general',
        headline: parsed?.headline ?? (info.message.split('\n')[0] || '(empty commit message)'),
        bullets: parsed?.bullets ?? [],
        deltas: parsed?.deltas ?? [],
        date: Number.isNaN(instantMs) ? info.date : new Date(instantMs).toISOString(),
      };
    });
    const response: MemoryLogResponse = { commits };
    return response;
  });

  app.get('/api/memory/diff', async (req, reply) => {
    const owned = await ownedGit(req, reply);
    if (!owned) return reply;
    const query = memoryDiffQuerySchema.safeParse(req.query);
    if (!query.success) {
      return sendError(reply, 400, 'invalid_query', formatIssues(query.error.issues));
    }
    const { from, to } = query.data;
    if (!refSchema.safeParse(from).success || !refSchema.safeParse(to).success) {
      return sendError(reply, 400, 'invalid_ref', 'Expected HEAD, HEAD~N, main, or a commit sha.');
    }
    let relPath: string | undefined;
    if (query.data.path !== undefined) {
      const safe = safeRelPath(query.data.path);
      if (safe === null) {
        return sendError(reply, 400, 'invalid_path', 'Not a workspace-relative file path.');
      }
      relPath = safe;
    }
    try {
      const [diff, stats] = await Promise.all([
        owned.git.diff(from, to, relPath),
        owned.git.diffStats(from, to, relPath),
      ]);
      const response: MemoryDiffResponse = { from, to, diff, stats };
      return response;
    } catch {
      return sendError(reply, 404, 'not_found', 'One of the refs does not exist in this memory.');
    }
  });

  app.get('/api/memory/export', async (req, reply) => {
    const owned = await ownedGit(req, reply);
    if (!owned) return reply;
    const zip = await owned.git.archiveZip('HEAD');
    if (zip === null) {
      return sendError(reply, 404, 'no_memory', 'This learner has no committed memory yet.');
    }
    const stamp = new Date().toISOString().slice(0, 10);
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="eduagent-memory-${stamp}.zip"`)
      .send(zip);
  });
};

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join('.') || 'query'}: ${issue.message}`).join('; ');
}
