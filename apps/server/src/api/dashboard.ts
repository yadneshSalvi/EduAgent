import type { FastifyPluginAsync } from 'fastify';
import { sendError } from './http.js';

/** GET /api/dashboard → the full DashboardData payload (plans/03 §7, `02` §6). */
export const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/dashboard', async (req, reply) => {
    const authed = await app.resolveUser(req);
    if (!authed) return sendError(reply, 401, 'unauthenticated');
    if (!app.dashboard) {
      return sendError(reply, 503, 'not_ready', 'The dashboard service has not finished booting.');
    }
    return app.dashboard.get(authed.userId);
  });
};
