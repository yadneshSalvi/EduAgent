import type { Thread, ItemMirror } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createThreadRequestSchema,
  listThreadsQuerySchema,
  type ThreadItem,
  type ThreadItemsResponse,
  type ThreadMode,
  type ThreadSummary,
} from '@eduagent/shared';
import { sendError } from './http.js';

/**
 * Thread REST routes (plans/03 §7): list / ensure / items / interrupt.
 * Bodies and queries are zod-validated against the shared schemas; responses
 * serialize to the shared shapes EXACTLY (dates as ISO strings).
 */

/** Items pagination — the shared schema fixes the response shape only. */
const itemsQuerySchema = z.object({
  take: z.coerce.number().int().positive().max(500).default(200),
  skip: z.coerce.number().int().min(0).default(0),
});

export const threadRoutes: FastifyPluginAsync = async (app) => {
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const authed = await app.resolveUser(req);
    if (!authed) {
      await sendError(reply, 401, 'unauthenticated');
      return null;
    }
    return authed;
  };

  const requireThreads = async (reply: FastifyReply) => {
    if (!app.threads) {
      await sendError(reply, 503, 'not_ready', 'The agent backend has not finished booting.');
      return null;
    }
    return app.threads;
  };

  /** The thread, or null after replying 404 (missing and foreign look alike). */
  const ownedThread = async (req: FastifyRequest, reply: FastifyReply, userId: string) => {
    const { id } = req.params as { id: string };
    const thread = await app.prisma.thread.findUnique({ where: { id } });
    if (!thread || thread.userId !== userId) {
      await sendError(reply, 404, 'not_found', 'No such thread.');
      return null;
    }
    return thread;
  };

  app.get('/api/threads', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const query = listThreadsQuerySchema.safeParse(req.query);
    if (!query.success) {
      return sendError(reply, 400, 'invalid_query', formatIssues(query.error.issues));
    }
    const threads = await app.prisma.thread.findMany({
      where: {
        userId: authed.userId,
        ...(query.data.mode ? { mode: query.data.mode } : {}),
        ...(query.data.track ? { trackSlug: query.data.track } : {}),
      },
      orderBy: { lastActiveAt: 'desc' },
    });
    return { threads: threads.map(toThreadSummary) };
  });

  app.post('/api/threads', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const threads = await requireThreads(reply);
    if (!threads) return reply;
    const body = createThreadRequestSchema.safeParse(req.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_body', formatIssues(body.error.issues));
    }
    if (body.data.mode !== 'learn') {
      return sendError(
        reply,
        400,
        'unsupported_mode',
        body.data.mode === 'exam'
          ? 'Exam threads are forked via POST /api/exams (Phase 4).'
          : body.data.mode === 'plan'
            ? 'Plan threads are created via POST /api/tracks.'
            : 'Review sessions start via POST /api/review/start.',
      );
    }
    const { thread } = await threads.ensureThread(authed.userId, 'learn', {
      topicSlug: body.data.topicSlug ?? null,
    });
    return toThreadSummary(thread);
  });

  app.get('/api/threads/:id/items', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const thread = await ownedThread(req, reply, authed.userId);
    if (!thread) return reply;
    const query = itemsQuerySchema.safeParse(req.query);
    if (!query.success) {
      return sendError(reply, 400, 'invalid_query', formatIssues(query.error.issues));
    }
    const items = await app.prisma.itemMirror.findMany({
      where: { threadId: thread.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.data.take,
      skip: query.data.skip,
    });
    const response: ThreadItemsResponse = { items: items.map(toThreadItem) };
    return response;
  });

  app.post('/api/threads/:id/interrupt', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const threads = await requireThreads(reply);
    if (!threads) return reply;
    const thread = await ownedThread(req, reply, authed.userId);
    if (!thread) return reply;
    await threads.interrupt(thread.id);
    return { ok: true as const };
  });
};

function toThreadSummary(thread: Thread): ThreadSummary {
  return {
    id: thread.id,
    mode: thread.mode as ThreadMode,
    topicSlug: thread.topicSlug,
    trackSlug: thread.trackSlug,
    roadmapDay: thread.roadmapDay,
    intent: thread.intent as ThreadSummary['intent'],
    title: thread.title,
    status: thread.status as ThreadSummary['status'],
    forkedFromId: thread.forkedFromId,
    createdAt: thread.createdAt.toISOString(),
    lastActiveAt: thread.lastActiveAt.toISOString(),
  };
}

function toThreadItem(item: ItemMirror): ThreadItem {
  return {
    id: item.id,
    codexItemId: item.codexItemId,
    role: item.role as ThreadItem['role'],
    kind: item.kind as ThreadItem['kind'],
    payload: item.payload,
    createdAt: item.createdAt.toISOString(),
  };
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}
