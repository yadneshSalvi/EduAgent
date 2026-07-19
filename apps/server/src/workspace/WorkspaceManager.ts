import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  profileFrontmatterSchema,
  roadmapFileSchema,
  sessionLogFrontmatterSchema,
  srsQueueFileSchema,
  trackFileSchema,
  masteryFileSchema,
  type SrsQueueFile,
  type RoadmapFile,
  type TrackFile,
} from '@eduagent/shared';
import { workspacePathFor, type AppConfig } from '../config.js';
import { installSkills, type SkillInstallResult } from '../prompts/skills.js';
import { formatStateDigest, type DigestOptions } from './digest.js';
import { GitService } from './GitService.js';
import {
  parseFrontmatterFile,
  parseOpenMisconceptions,
  parseYamlFile,
  readValidated,
} from './learner-files.js';
import type { LearnerModel, SessionSummary, TopicModel } from './model.js';
import { WORKSPACE_INIT_COMMIT, WORKSPACE_TEMPLATE } from './template.js';

/** Minimal pino-compatible logging surface so tests can inject a spy. */
export interface WorkspaceLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

export interface EnsureWorkspaceResult {
  path: string;
  created: boolean;
}

/**
 * Owns the per-user git workspaces ("Memory", plans/03 §3.2): creation from
 * template, validated reads with last-known-good fallback, the per-turn state
 * digest, and boot-time skill installation at $DATA_DIR/.codex/skills.
 */
export class WorkspaceManager {
  private readonly gitServices = new Map<string, GitService>();
  private readonly pendingEnsure = new Map<string, Promise<EnsureWorkspaceResult>>();
  private readonly logger: WorkspaceLogger;

  constructor(
    private readonly config: AppConfig,
    deps: { logger?: WorkspaceLogger } = {},
  ) {
    this.logger = deps.logger ?? noopLogger;
  }

  /** Absolute workspace path for a user; rejects ids that could escape dataDir. */
  pathFor(userId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(userId)) {
      throw new Error(`invalid userId for workspace path: ${JSON.stringify(userId)}`);
    }
    return workspacePathFor(this.config, userId);
  }

  /**
   * True once the user's workspace repo exists on disk. Read-only endpoints
   * (dashboard, memory explorer) use this instead of ensureWorkspace so a GET
   * never creates state — and never constructs a GitService on a missing dir.
   */
  hasWorkspace(userId: string): boolean {
    return existsSync(path.join(this.pathFor(userId), '.git'));
  }

  /** GitService scoped to this user's workspace (cached per user). */
  git(userId: string): GitService {
    let service = this.gitServices.get(userId);
    if (!service) {
      service = new GitService(this.pathFor(userId));
      this.gitServices.set(userId, service);
    }
    return service;
  }

  /**
   * Creates the workspace from template + `git init` + initial commit
   * `system: initialize memory`. Idempotent (an existing repo is left
   * untouched) and race-safe per user within this process.
   */
  async ensureWorkspace(userId: string): Promise<EnsureWorkspaceResult> {
    const pending = this.pendingEnsure.get(userId);
    if (pending) return pending;
    const promise = this.createIfMissing(userId).finally(() => this.pendingEnsure.delete(userId));
    this.pendingEnsure.set(userId, promise);
    return promise;
  }

  private async createIfMissing(userId: string): Promise<EnsureWorkspaceResult> {
    const dir = this.pathFor(userId);
    if (existsSync(path.join(dir, '.git'))) return { path: dir, created: false };
    for (const file of WORKSPACE_TEMPLATE) {
      const abs = path.join(dir, file.path);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, file.content, 'utf8');
    }
    const git = this.git(userId);
    await git.init();
    const sha = await git.commitAll(WORKSPACE_INIT_COMMIT);
    this.logger.info({ userId, dir, sha }, 'workspace initialized');
    return { path: dir, created: true };
  }

  /**
   * Parses + zod-validates every learner-model file. Invalid on-disk files
   * fall back to their HEAD version and land in `needsRepair` (the next
   * turn's context tells the agent to fix them, plans/03 §3.2). Discovery
   * unions disk contents with `git ls-files`, so a deleted tracked file is
   * still recovered and flagged.
   */
  async readLearnerModel(userId: string): Promise<LearnerModel> {
    const dir = this.pathFor(userId);
    const git = this.git(userId);
    const tracked = await git.lsFiles();
    const needsRepair: string[] = [];
    const flag = (relPath: string, repair: boolean) => {
      if (repair) needsRepair.push(relPath);
    };

    const profileRead = await readValidated(dir, git, 'profile.md', (raw) =>
      parseFrontmatterFile(profileFrontmatterSchema, raw),
    );
    flag('profile.md', profileRead.needsRepair);

    const tracks: TrackFile[] = [];
    for (const relPath of await this.discoverTrackFiles(dir, tracked, 'track.yaml')) {
      const read = await readValidated(dir, git, relPath, (raw) =>
        parseYamlFile(trackFileSchema, raw),
      );
      flag(relPath, read.needsRepair);
      if (read.value) tracks.push(read.value);
    }
    tracks.sort((a, b) => a.track.localeCompare(b.track));

    const roadmaps: RoadmapFile[] = [];
    for (const relPath of await this.discoverTrackFiles(dir, tracked, 'roadmap.yaml')) {
      const read = await readValidated(dir, git, relPath, (raw) =>
        parseYamlFile(roadmapFileSchema, raw),
      );
      flag(relPath, read.needsRepair);
      if (read.value) roadmaps.push(read.value);
    }
    roadmaps.sort((a, b) => a.track.localeCompare(b.track));

    const topics: TopicModel[] = [];
    for (const topic of await this.discoverTopics(dir, tracked)) {
      const masteryPath = `topics/${topic}/mastery.yaml`;
      const masteryRead = await readValidated(dir, git, masteryPath, (raw) =>
        parseYamlFile(masteryFileSchema, raw),
      );
      flag(masteryPath, masteryRead.needsRepair);
      const misconceptionsRaw = await this.readRaw(dir, git, `topics/${topic}/misconceptions.md`);
      topics.push({
        topic,
        displayName: masteryRead.value?.display_name ?? topic,
        mastery: masteryRead.value,
        openMisconceptions: misconceptionsRaw ? parseOpenMisconceptions(misconceptionsRaw) : [],
      });
    }
    topics.sort((a, b) => a.topic.localeCompare(b.topic));

    const srsRead = await readValidated(dir, git, 'srs/queue.yaml', (raw) =>
      parseYamlFile(srsQueueFileSchema, raw),
    );
    flag('srs/queue.yaml', srsRead.needsRepair);
    const srs: SrsQueueFile = srsRead.value ?? { items: [] };

    let lastSession: SessionSummary | null = null;
    const sessionFiles = await this.discover(dir, tracked, 'sessions', /\.md$/);
    const latest = sessionFiles.sort().at(-1);
    if (latest) {
      const read = await readValidated(dir, git, latest, (raw) =>
        parseFrontmatterFile(sessionLogFrontmatterSchema, raw),
      );
      flag(latest, read.needsRepair);
      if (read.value) lastSession = { file: latest, ...read.value };
    }

    return {
      profile: profileRead.value,
      tracks,
      roadmaps,
      topics,
      srs,
      lastSession,
      needsRepair,
    };
  }

  /** The compact per-turn digest (plans/03 §3.2); capped at ~600 tokens. */
  async stateDigest(userId: string, opts: DigestOptions = {}): Promise<string> {
    return formatStateDigest(await this.readLearnerModel(userId), opts);
  }

  /**
   * True once profile.md exists in a COMMIT — the `onboarded` signal for
   * /auth/me and for choosing onboarding vs learn instructions (plans/03 §7;
   * the template deliberately ships no profile.md). Added in task #11: this
   * is workspace knowledge, and consumers must not touch git directly.
   */
  async hasCommittedProfile(userId: string): Promise<boolean> {
    if (!existsSync(path.join(this.pathFor(userId), '.git'))) return false;
    return (await this.git(userId).fileAtRef('HEAD', 'profile.md')) !== null;
  }

  /**
   * Installs the teach/memory skills at $DATA_DIR/.codex/skills so every
   * workspace under $DATA_DIR/workspaces inherits them via ancestor-walk
   * discovery (plans/01 §4.0 fact 6). Idempotent; call at boot.
   */
  async ensureSkillsInstalled(): Promise<SkillInstallResult[]> {
    const results = await installSkills(this.config.dataDir);
    this.logger.info(
      { skills: results.map((r) => `${r.name}:${r.action}`) },
      'codex skills ensured',
    );
    return results;
  }

  /** Files under `<subdir>/` matching `pattern`, unioned across disk and git index. */
  private async discover(
    dir: string,
    tracked: string[],
    subdir: string,
    pattern: RegExp,
  ): Promise<string[]> {
    const found = new Set<string>();
    try {
      for (const name of await fs.readdir(path.join(dir, subdir))) {
        if (pattern.test(name)) found.add(`${subdir}/${name}`);
      }
    } catch {
      // subdir missing on disk — tracked files may still exist
    }
    for (const relPath of tracked) {
      const match =
        relPath.startsWith(`${subdir}/`) && !relPath.slice(subdir.length + 1).includes('/');
      if (match && pattern.test(relPath)) found.add(relPath);
    }
    return [...found].sort();
  }

  /**
   * Track-layout discovery is directory-aware while discover() deliberately
   * remains flat for sessions and other one-level collections.
   */
  private async discoverTrackFiles(
    dir: string,
    tracked: string[],
    filename: 'track.yaml' | 'roadmap.yaml',
  ): Promise<string[]> {
    const found = new Set<string>();
    try {
      for (const entry of await fs.readdir(path.join(dir, 'tracks'), { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const relPath = `tracks/${entry.name}/${filename}`;
        if (existsSync(path.join(dir, relPath))) found.add(relPath);
      }
    } catch {
      // tracks/ absent on disk — tracked paths may still be recoverable
    }
    for (const relPath of tracked) {
      const segments = relPath.split('/');
      if (segments.length === 3 && segments[0] === 'tracks' && segments[2] === filename) {
        found.add(relPath);
      }
    }
    return [...found].sort();
  }

  /** Topic slugs, unioned across `topics/*` disk dirs and tracked `topics/<t>/…` paths. */
  private async discoverTopics(dir: string, tracked: string[]): Promise<string[]> {
    const topics = new Set<string>();
    try {
      for (const entry of await fs.readdir(path.join(dir, 'topics'), { withFileTypes: true })) {
        if (entry.isDirectory()) topics.add(entry.name);
      }
    } catch {
      // no topics dir yet
    }
    for (const relPath of tracked) {
      const segments = relPath.split('/');
      if (segments[0] === 'topics' && segments.length > 2 && segments[1]) topics.add(segments[1]);
    }
    return [...topics].sort();
  }

  /** Raw file content from disk, falling back to HEAD (for non-schema files). */
  private async readRaw(dir: string, git: GitService, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(dir, relPath), 'utf8');
    } catch {
      return git.fileAtRef('HEAD', relPath);
    }
  }
}
