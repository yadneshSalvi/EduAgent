import type { Thread } from '@prisma/client';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  completeTrackDaySchema,
  createTrackSessionSchema,
  trackIntakeSchema,
  type CreateTrackResponse,
  type ThreadMode,
  type ThreadSummary,
} from '@eduagent/shared';
import {
  TrackDayError,
  TrackNotFoundError,
  TrackSlugTakenError,
  TrackStateError,
} from '../learning/index.js';
import { sendError } from './http.js';

const dayParamsSchema = z.object({
  slug: z.string().min(1),
  day: z.coerce.number().int().positive(),
});

/** Learning-track state-machine routes; all ownership stays inside TrackService. */
export const trackRoutes: FastifyPluginAsync = async (app) => {
  const requireUser = async (req: FastifyRequest, reply: FastifyReply) => {
    const authed = await app.resolveUser(req);
    if (!authed) {
      await sendError(reply, 401, 'unauthenticated');
      return null;
    }
    return authed;
  };
  const requireTracks = async (reply: FastifyReply) => {
    if (!app.tracks) {
      await sendError(reply, 503, 'not_ready', 'The track service has not finished booting.');
      return null;
    }
    return app.tracks;
  };
  const slug = (req: FastifyRequest): string => (req.params as { slug: string }).slug;
  const mapError = (reply: FastifyReply, err: unknown): FastifyReply => {
    if (
      err instanceof TrackNotFoundError ||
      err instanceof TrackStateError ||
      err instanceof TrackDayError ||
      err instanceof TrackSlugTakenError
    ) {
      return sendError(reply, err.statusCode, err.code, err.message);
    }
    throw err;
  };

  app.get('/api/tracks', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    return { tracks: await tracks.list(authed.userId) };
  });

  app.post('/api/tracks', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    const body = trackIntakeSchema.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_body', zodIssues(body.error));
    try {
      const created = await tracks.create(authed.userId, body.data);
      const response: CreateTrackResponse = created;
      return response;
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get('/api/tracks/:slug', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    try {
      return await tracks.detail(authed.userId, slug(req));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post('/api/tracks/:slug/generate', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    try {
      return await tracks.generate(authed.userId, slug(req));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post('/api/tracks/:slug/archive', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    try {
      await tracks.archive(authed.userId, slug(req));
      return { ok: true as const };
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post('/api/tracks/:slug/days/:day/complete', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    const params = dayParamsSchema.safeParse(req.params);
    const body = completeTrackDaySchema.safeParse(req.body ?? {});
    if (!params.success) return sendError(reply, 400, 'invalid_day', zodIssues(params.error));
    if (!body.success) return sendError(reply, 400, 'invalid_body', zodIssues(body.error));
    try {
      return await tracks.completeDay(authed.userId, params.data.slug, params.data.day, body.data);
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.post('/api/tracks/:slug/sessions', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    const body = createTrackSessionSchema.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_body', zodIssues(body.error));
    try {
      return toThreadSummary(await tracks.createSession(authed.userId, slug(req), body.data));
    } catch (err) {
      return mapError(reply, err);
    }
  });

  app.get('/api/tracks/:slug/sessions', async (req, reply) => {
    const authed = await requireUser(req, reply);
    if (!authed) return reply;
    const tracks = await requireTracks(reply);
    if (!tracks) return reply;
    try {
      return await tracks.sessions(authed.userId, slug(req));
    } catch (err) {
      return mapError(reply, err);
    }
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

function zodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}
