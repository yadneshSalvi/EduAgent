import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { simpleGit, type SimpleGit } from 'simple-git';
import {
  MASTERY_DELTA_RE,
  MEMORY_COMMIT_HEADER_RE,
  masteryDeltaSchema,
  parsedMemoryCommitSchema,
  type DiffStats,
  type ParsedMemoryCommit,
} from '@eduagent/shared';

/** All workspace commits carry this identity (plans/02 §3). */
export const AGENT_GIT_AUTHOR = { name: 'EduAgent', email: 'agent@eduagent.local' } as const;

export interface GitCommitInfo {
  sha: string;
  /** Full commit message: subject line + blank line + body (when a body exists). */
  message: string;
  authorName: string;
  authorEmail: string;
  /** Author date, ISO 8601. */
  date: string;
}

export interface GitStatusSummary {
  isDirty: boolean;
  /** Workspace-relative paths of changed/untracked files. */
  files: string[];
}

export interface CommitDiff {
  /** Unified diff of the whole commit (empty-tree base for the root commit). */
  diff: string;
  stats: DiffStats;
}

/**
 * Parses a memory-commit message per the plans/02 §3 grammar, built on the
 * shared regexes. Returns null when the subject line doesn't follow
 * `<type>(<topic>): <headline>` — callers decide how loudly to complain.
 * Malformed headline deltas (out-of-range scores) are dropped, not fatal.
 */
export function parseCommit(message: string): ParsedMemoryCommit | null {
  const lines = message.split('\n');
  const header = MEMORY_COMMIT_HEADER_RE.exec((lines[0] ?? '').trim());
  if (!header) return null;
  const [, type, topic, headline] = header;
  if (!type || !headline) return null;
  const deltas = [...headline.matchAll(MASTERY_DELTA_RE)]
    .map((m) => ({ concept: m[1], from: Number(m[2]), to: Number(m[3]) }))
    .filter((d) => masteryDeltaSchema.safeParse(d).success);
  const bullets = lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+/, ''));
  const parsed = parsedMemoryCommitSchema.safeParse({
    type,
    topic: topic ?? null,
    headline,
    bullets,
    deltas,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * simple-git wrapper scoped to one user workspace (plans/03 §3.3). All methods
 * return typed data; nothing here knows about users, threads, or the DB.
 */
export class GitService {
  private readonly git: SimpleGit;

  constructor(readonly workspaceDir: string) {
    this.git = simpleGit(workspaceDir);
  }

  /**
   * `git init -b main` plus repo-local identity, so every commit in this
   * workspace — ours or the agent's own `git commit` — is authored as
   * EduAgent regardless of machine-level git config.
   */
  async init(): Promise<void> {
    await this.git.raw(['init', '-b', 'main']);
    await this.git.addConfig('user.name', AGENT_GIT_AUTHOR.name);
    await this.git.addConfig('user.email', AGENT_GIT_AUTHOR.email);
    await this.git.addConfig('commit.gpgsign', 'false');
  }

  /** Current HEAD sha, or null before the first commit / outside a repo. */
  async headSha(): Promise<string | null> {
    try {
      return (await this.git.revparse(['HEAD'])).trim();
    } catch {
      return null;
    }
  }

  async status(): Promise<GitStatusSummary> {
    const status = await this.git.status();
    return { isDirty: !status.isClean(), files: status.files.map((f) => f.path) };
  }

  /**
   * Stages everything and commits as EduAgent; returns the new HEAD sha.
   * `backdate` sets GIT_AUTHOR_DATE/GIT_COMMITTER_DATE (seeded history,
   * plans/02 §3).
   */
  async commitAll(message: string, opts: { backdate?: Date } = {}): Promise<string> {
    // Ambient GIT_* vars (GIT_DIR, GIT_EDITOR, …) would misdirect the child
    // git or trip simple-git's unsafe-env guard — drop them before adding
    // ours. Plain EDITOR/VISUAL trip the same guard (simple-git scans any
    // EXPLICITLY passed env, and npx/IDE shells commonly set EDITOR — found
    // live by the Phase 4 E2E).
    const cleanEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !key.startsWith('GIT_') && key !== 'EDITOR' && key !== 'VISUAL',
      ),
    ) as Record<string, string>;
    const git = opts.backdate
      ? simpleGit(this.workspaceDir).env({
          ...cleanEnv,
          GIT_AUTHOR_DATE: opts.backdate.toISOString(),
          GIT_COMMITTER_DATE: opts.backdate.toISOString(),
        })
      : this.git;
    await git.add(['-A']);
    await git.commit(message, undefined, {
      '--author': `${AGENT_GIT_AUTHOR.name} <${AGENT_GIT_AUTHOR.email}>`,
    });
    const sha = await this.headSha();
    if (!sha) throw new Error(`commitAll produced no HEAD in ${this.workspaceDir}`);
    return sha;
  }

  /**
   * Commits newest-first. `from` bounds the range as `from..HEAD` (exclusive
   * of `from` itself) — pass the sha captured before a turn to get the turn's
   * commits. Empty repo → [].
   */
  async log(opts: { from?: string; maxCount?: number } = {}): Promise<GitCommitInfo[]> {
    try {
      const result = await this.git.log({
        ...(opts.from ? { from: opts.from, to: 'HEAD', symmetric: false } : {}),
        ...(opts.maxCount ? { maxCount: opts.maxCount } : {}),
      });
      return result.all.map((entry) => ({
        sha: entry.hash,
        message: entry.body.trim() ? `${entry.message}\n\n${entry.body.trim()}` : entry.message,
        authorName: entry.author_name,
        authorEmail: entry.author_email,
        date: entry.date,
      }));
    } catch {
      // git log on a repo with no commits exits non-zero; that's a valid state.
      return [];
    }
  }

  /** Raw `git show <sha>` output (commit header + diff). */
  async show(sha: string): Promise<string> {
    return this.git.show([sha]);
  }

  /** Unified diff between two refs, optionally narrowed to one path. */
  async diff(from: string, to: string, filePath?: string): Promise<string> {
    return this.git.diff([`${from}..${to}`, ...(filePath ? ['--', filePath] : [])]);
  }

  /** Numstat totals between two refs (the time-machine summary strip). */
  async diffStats(from: string, to: string, filePath?: string): Promise<DiffStats> {
    const numstat = await this.git.diff([
      '--numstat',
      `${from}..${to}`,
      ...(filePath ? ['--', filePath] : []),
    ]);
    return parseNumstat(numstat);
  }

  /** Full diff + numstat totals for a single commit (root commit included). */
  async diffForCommit(sha: string): Promise<CommitDiff> {
    const diff = await this.git.show(['--format=', '--patch', sha]);
    const numstat = await this.git.show(['--format=', '--numstat', sha]);
    return { diff, stats: parseNumstat(numstat) };
  }

  /**
   * True when `ancestor` is an ancestor of (or equal to) `ref`. Compares the
   * merge-base to the resolved sha — `merge-base --is-ancestor` signals via
   * exit code 1, which simple-git's raw() swallows (resolves empty).
   */
  async isAncestor(ancestor: string, ref = 'HEAD'): Promise<boolean> {
    try {
      const base = (await this.git.raw(['merge-base', ancestor, ref])).trim();
      const resolved = (await this.git.revparse([ancestor])).trim();
      return base !== '' && base === resolved;
    } catch {
      return false;
    }
  }

  /** File content at a ref (e.g. last-known-good `HEAD:topics/sql/mastery.yaml`), or null. */
  async fileAtRef(ref: string, filePath: string): Promise<string | null> {
    try {
      return await this.git.show([`${ref}:${filePath.split(/[\\/]/).join('/')}`]);
    } catch {
      return null;
    }
  }

  /** Workspace-relative paths of all git-tracked files. */
  async lsFiles(): Promise<string[]> {
    try {
      const out = await this.git.raw(['ls-files']);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Workspace-relative paths of all files in a COMMIT's tree (default HEAD).
   * The memory explorer serves committed content only (plans/03 §7) — this is
   * the tree that matches what `blobAtRef` can serve.
   */
  async lsTree(ref = 'HEAD'): Promise<string[]> {
    try {
      const out = await this.git.raw(['ls-tree', '-r', '--name-only', ref]);
      return out.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Blob content at `ref:path`, or null when the path is absent at that ref
   * OR is not a regular file (directories/submodules never leak as content).
   * Unlike `fileAtRef` (which `git show`s whatever the spec names), this
   * verifies the object type first — the memory-explorer file endpoint uses
   * it so a directory path can't return a tree listing.
   */
  async blobAtRef(ref: string, filePath: string): Promise<string | null> {
    const spec = `${ref}:${filePath.split(/[\\/]/).join('/')}`;
    try {
      const type = (await this.git.catFile(['-t', spec])).trim();
      if (type !== 'blob') return null;
      return await this.git.catFile(['blob', spec]);
    } catch {
      return null;
    }
  }

  /**
   * Zip of the full tree at `ref` (default HEAD) via `git archive` — exactly
   * the committed content, so gitignored/untracked files can never ride along
   * (plans/03 §7, plans/04 §7 "Export my memory"). Null before the first
   * commit. Spawned directly (not simple-git) because the output is binary.
   */
  async archiveZip(ref = 'HEAD'): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['-C', this.workspaceDir, 'archive', '--format=zip', ref],
        { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return null;
    }
  }
}

const execFileAsync = promisify(execFile);

function parseNumstat(numstat: string): DiffStats {
  const stats: DiffStats = { filesChanged: 0, insertions: 0, deletions: 0 };
  for (const line of numstat.split('\n')) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match) continue;
    stats.filesChanged += 1;
    // Binary files report "-" for both counts.
    stats.insertions += match[1] === '-' ? 0 : Number(match[1]);
    stats.deletions += match[2] === '-' ? 0 : Number(match[2]);
  }
  return stats;
}
