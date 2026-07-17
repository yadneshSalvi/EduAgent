import type { PrismaClient, Prisma } from '@prisma/client';
import type { MemoryCommit, ParsedMemoryCommit, WsEventOf } from '@eduagent/shared';
import { parseCommit } from './GitService.js';
import type { WorkspaceLogger, WorkspaceManager } from './WorkspaceManager.js';

/**
 * How memory.commit events leave the pipeline. The WS gateway (task #11)
 * implements this; tests inject a recorder. The pipeline never imports the
 * gateway.
 */
export interface MemoryCommitEmitter {
  emitToUser(userId: string, event: WsEventOf<'memory.commit'>): void;
}

export interface MemoryPipelineDeps {
  workspaces: WorkspaceManager;
  prisma: PrismaClient;
  emitter: MemoryCommitEmitter;
  /** Cache-invalidation hook (DashboardService per plans/03 §3.4); called once per turn with commits. */
  onMemoryChanged?: (userId: string) => void;
  logger?: WorkspaceLogger;
}

export interface MemoryTurnContext {
  userId: string;
  /** Our Thread row id — for logs/ActivityEvent meta only. */
  threadId: string;
  topicSlug?: string | null;
  /** HEAD sha captured via beforeTurn() when the turn started; null = no commits yet. */
  sinceSha: string | null;
}

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

/**
 * Runs after every turn/completed (plans/03 §3.4):
 *  1. dirty workspace → warn (prompt-bug) + checkpoint commit
 *  2. collect commits made during the turn
 *  3. per commit: parse + diff → emit `memory.commit`, write ActivityEvent,
 *     then invalidate caches.
 */
export class MemoryPipeline {
  private readonly workspaces: WorkspaceManager;
  private readonly prisma: PrismaClient;
  private readonly emitter: MemoryCommitEmitter;
  private readonly onMemoryChanged?: (userId: string) => void;
  private readonly logger: WorkspaceLogger;

  constructor(deps: MemoryPipelineDeps) {
    this.workspaces = deps.workspaces;
    this.prisma = deps.prisma;
    this.emitter = deps.emitter;
    this.onMemoryChanged = deps.onMemoryChanged;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Capture the pre-turn HEAD; pass it to afterTurn as `sinceSha`. */
  async beforeTurn(userId: string): Promise<string | null> {
    return this.workspaces.git(userId).headSha();
  }

  /** Returns the turn's memory commits, oldest first, as broadcast to the UI. */
  async afterTurn(ctx: MemoryTurnContext): Promise<MemoryCommit[]> {
    const git = this.workspaces.git(ctx.userId);

    const status = await git.status();
    if (status.isDirty) {
      // The memory skill tells the agent to commit after every learning event;
      // reaching this safety net means a prompt needs tuning (plans/02 §3).
      this.logger.warn(
        { tag: 'prompt-bug', threadId: ctx.threadId, files: status.files },
        'workspace dirty after turn — writing checkpoint commit',
      );
      await git.commitAll(`system(${ctx.topicSlug ?? 'general'}): checkpoint memory`);
    }

    // Tamper-evidence for the .git writableRoots tradeoff (PROTOCOL_NOTES
    // Phase 1 addenda): the sandbox lets the agent rewrite its own memory
    // history, so a pre-turn HEAD that is no longer an ancestor means the
    // ledger was rewritten mid-turn. Log-only in Phase 1.
    if (ctx.sinceSha !== null && !(await git.isAncestor(ctx.sinceSha, 'HEAD'))) {
      this.logger.warn(
        { tag: 'memory-history-rewritten', threadId: ctx.threadId, sinceSha: ctx.sinceSha },
        'pre-turn HEAD is no longer an ancestor of HEAD — memory history was rewritten during this turn',
      );
    }

    const commits = await git.log(ctx.sinceSha ? { from: ctx.sinceSha } : {});
    const events: MemoryCommit[] = [];
    for (const info of [...commits].reverse()) {
      let parsed: ParsedMemoryCommit | null = parseCommit(info.message);
      if (!parsed) {
        this.logger.warn(
          { tag: 'prompt-bug', threadId: ctx.threadId, sha: info.sha, message: info.message },
          'memory commit does not follow the commit grammar',
        );
        parsed = {
          type: 'system',
          topic: null,
          headline: info.message.split('\n')[0] ?? '(empty commit message)',
          bullets: [],
          deltas: [],
        };
      }
      const { diff, stats } = await git.diffForCommit(info.sha);
      const commit: MemoryCommit = {
        ...parsed,
        topic: parsed.topic ?? 'general',
        sha: info.sha,
        stats,
        diff,
      };
      await this.prisma.activityEvent.create({
        data: {
          userId: ctx.userId,
          kind: 'commit',
          meta: {
            threadId: ctx.threadId,
            sha: commit.sha,
            type: commit.type,
            topic: commit.topic,
            headline: commit.headline,
            bullets: commit.bullets,
            deltas: commit.deltas,
            stats: commit.stats,
          } satisfies Prisma.InputJsonValue,
        },
      });
      this.emitter.emitToUser(ctx.userId, { type: 'memory.commit', commit });
      events.push(commit);
    }

    if (events.length > 0) this.onMemoryChanged?.(ctx.userId);
    return events;
  }
}
