import type { FastifyPluginAsync } from 'fastify';
import type { StartReviewResponse } from '@eduagent/shared';
import { NothingDueError } from '../learning/index.js';
import { sendError } from './http.js';

/** Review mode (plans/03 §7): GET /api/review/queue · POST /api/review/start. */
export const reviewRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/review/queue', async (req, reply) => {
    const authed = await app.resolveUser(req);
    if (!authed) return sendError(reply, 401, 'unauthenticated');
    if (!app.review) {
      return sendError(reply, 503, 'not_ready', 'The review service has not finished booting.');
    }
    return app.review.queue(authed.userId);
  });

  app.post('/api/review/start', async (req, reply) => {
    const authed = await app.resolveUser(req);
    if (!authed) return sendError(reply, 401, 'unauthenticated');
    if (!app.review) {
      return sendError(reply, 503, 'not_ready', 'The review service has not finished booting.');
    }
    try {
      const { threadId } = await app.review.start(authed.userId);
      const response: StartReviewResponse = { threadId };
      return response;
    } catch (err) {
      if (err instanceof NothingDueError) {
        return sendError(reply, 409, 'nothing_due', 'No reviews are due right now.');
      }
      throw err;
    }
  });
};
