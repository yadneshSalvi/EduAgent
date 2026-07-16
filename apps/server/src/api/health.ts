import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async (req, reply) => {
    try {
      // Counting an actual table (not SELECT 1) also proves migrations ran.
      await app.prisma.user.count();
    } catch (err) {
      req.log.error({ err }, 'healthz: database unreachable — run `pnpm db:setup`?');
      return reply
        .code(503)
        .send({ ok: false, checks: { db: 'unreachable', codex: 'pending (Phase 1)' } });
    }
    // Phase 1 adds a codex app-server liveness check here.
    return { ok: true, checks: { db: 'ok', codex: 'pending (Phase 1)' } };
  });
};
