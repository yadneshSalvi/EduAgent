import type { FastifyPluginAsync } from 'fastify';

/**
 * /healthz: db + codex both reported; 503 only when the DATABASE fails —
 * codex being down is visible but non-fatal so the web app keeps working
 * against ItemMirror while codex restarts (task #11 boot wiring).
 */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  // rateLimit:false — the uptime pinger must never be throttled (plans/08 §5);
  // inert when RATE_LIMITS is off (the plugin is not registered).
  app.get('/healthz', { config: { rateLimit: false } }, async (req, reply) => {
    let codex = 'not started';
    if (app.codexHealth) {
      const probe = await app.codexHealth();
      codex = probe.ok ? 'ok' : `unavailable: ${probe.detail ?? 'unknown'}`;
    }
    try {
      // Counting an actual table (not SELECT 1) also proves migrations ran.
      await app.prisma.user.count();
    } catch (err) {
      req.log.error({ err }, 'healthz: database unreachable — run `pnpm db:setup`?');
      return reply.code(503).send({ ok: false, checks: { db: 'unreachable', codex } });
    }
    return { ok: true, checks: { db: 'ok', codex } };
  });
};
