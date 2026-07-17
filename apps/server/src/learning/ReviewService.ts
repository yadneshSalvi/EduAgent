/**
 * ReviewService (plans/03 §3.5): the read side of `GET /api/review/queue` and
 * the session starter behind `POST /api/review/start`. Starting a session
 * ensures the user's REVIEW thread (ThreadManager owns creation + the
 * review-mode developerInstructions) — a freshly created thread runs its
 * auto-greeting turn, a reused idle one gets a kickoff system turn. The due
 * list itself rides in every turn's context envelope (ThreadManager), so no
 * state is duplicated here.
 */
import type { PrismaClient } from '@prisma/client';
import { localDate, type ReviewQueueResponse } from '@eduagent/shared';
import { REVIEW_KICKOFF_INPUT } from '../prompts/index.js';
import type { ThreadService } from '../threads/index.js';
import type { WorkspaceLogger, WorkspaceManager } from '../workspace/index.js';
import { dueSummary } from './SrsEngine.js';

/** Thrown by start() when the queue has nothing due — routes map it to 409. */
export class NothingDueError extends Error {
  constructor() {
    super('No reviews are due right now.');
    this.name = 'NothingDueError';
  }
}

const noopLogger: WorkspaceLogger = { info: () => {}, warn: () => {} };

export interface ReviewServiceDeps {
  prisma: PrismaClient;
  workspaces: WorkspaceManager;
  threads: ThreadService;
  logger?: WorkspaceLogger;
}

export class ReviewService {
  private readonly prisma: PrismaClient;
  private readonly workspaces: WorkspaceManager;
  private readonly threads: ThreadService;
  private readonly logger: WorkspaceLogger;

  constructor(deps: ReviewServiceDeps) {
    this.prisma = deps.prisma;
    this.workspaces = deps.workspaces;
    this.threads = deps.threads;
    this.logger = deps.logger ?? noopLogger;
  }

  /** Due summary in the learner's timezone (profile.md, else User row, else UTC). */
  async queue(userId: string, opts: { now?: Date } = {}): Promise<ReviewQueueResponse> {
    const now = opts.now ?? new Date();
    if (!this.workspaces.hasWorkspace(userId)) {
      return { dueToday: 0, overdue: 0, items: [] };
    }
    const model = await this.workspaces.readLearnerModel(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const timezone = model.profile?.frontmatter.timezone ?? user?.timezone ?? 'UTC';
    const summary = dueSummary(model.srs, localDate(now, timezone));
    return {
      dueToday: summary.dueToday,
      overdue: summary.overdue,
      items: summary.due.map(({ topic, concept, due }) => ({ topic, concept, due })),
    };
  }

  /**
   * Starts (or resumes) the review session. New thread → ThreadManager's
   * auto-greeting opens it; existing idle thread → a kickoff system turn does
   * (fire-and-forget, like the greeting); turn already in flight → nothing to
   * kick, the client just attaches. Throws NothingDueError on an empty queue.
   */
  async start(userId: string): Promise<{ threadId: string }> {
    const queue = await this.queue(userId);
    if (queue.dueToday + queue.overdue === 0) throw new NothingDueError();

    const { thread, created } = await this.threads.ensureThread(userId, 'review');
    if (!created && !this.threads.turnInFlight(thread.id)) {
      void this.threads
        .startSystemTurn(thread, REVIEW_KICKOFF_INPUT, {
          caption: 'Review session started.',
        })
        .catch((err: unknown) => {
          this.logger.warn({ err, threadId: thread.id }, 'review kickoff turn failed');
        });
    }
    return { threadId: thread.id };
  }
}
