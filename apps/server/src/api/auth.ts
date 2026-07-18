import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import {
  demoLoginRequestSchema,
  localLoginRequestSchema,
  type LocalUsersResponse,
  type MeResponse,
} from '@eduagent/shared';
import { LOCAL_SESSION_COOKIE } from '../auth/index.js';
import { workspacePathFor } from '../config.js';
import { constantTimeEqual, sendError } from './http.js';

/** The /auth/* routes (plans/03 §7) — the only routes outside resolveUser auth. */
export const authRoutes: FastifyPluginAsync = async (app) => {
  const { appConfig: config, prisma } = app;

  app.get('/auth/me', async (req, reply) => {
    const authed = await app.resolveUser(req);
    if (!authed) return sendError(reply, 401, 'unauthenticated');
    const user = await prisma.user.findUnique({ where: { id: authed.userId } });
    if (!user) return sendError(reply, 401, 'unauthenticated');
    return toMeResponse(user, await isOnboarded(user.id));
  });

  /** onboarded = the workspace has a COMMITTED profile.md (plans/03 §7). */
  async function isOnboarded(userId: string): Promise<boolean> {
    if (!app.workspaces) return false;
    return app.workspaces.hasCommittedProfile(userId);
  }

  app.post('/auth/local-login', async (req, reply) => {
    if (config.authMode !== 'local') {
      return sendError(
        reply,
        404,
        'not_found',
        'POST /auth/local-login is only available when AUTH_MODE=local.',
      );
    }
    const parsed = localLoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_body', formatIssues(parsed.error.issues));
    }

    const { handle } = parsed.data;
    let user = await prisma.user.findUnique({ where: { handle } });
    if (!user) {
      const id = randomUUID();
      user = await prisma.user.create({
        data: { id, handle, displayName: handle, workspacePath: workspacePathFor(config, id) },
      });
      req.log.info({ userId: user.id, handle }, 'local-login created user');
    }

    reply.setCookie(LOCAL_SESSION_COOKIE, user.id, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: config.nodeEnv === 'production',
      maxAge: 60 * 60 * 24 * 30,
    });
    return toMeResponse(user, await isOnboarded(user.id));
  });

  /** Existing local profiles so the picker offers one-click sign-in (QA m6). */
  app.get('/auth/local-users', async (_req, reply) => {
    if (config.authMode !== 'local') {
      return sendError(
        reply,
        404,
        'not_found',
        'GET /auth/local-users is only available when AUTH_MODE=local.',
      );
    }
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { handle: true, displayName: true },
    });
    const response: LocalUsersResponse = { users };
    return response;
  });

  app.post('/auth/demo-login', async (req, reply) => {
    if (config.authMode !== 'clerk') {
      return sendError(
        reply,
        404,
        'not_found',
        'POST /auth/demo-login is only available in clerk mode (use /auth/local-login).',
      );
    }
    // Fail closed (plans/08 §5, Phase 0 review finding): an unset ACCESS_CODE
    // must refuse to mint sign-in tokens — never fall through as "no gate".
    if (!config.accessCode) {
      return sendError(
        reply,
        503,
        'demo_login_disabled',
        'Demo login is not configured on this deployment (ACCESS_CODE is unset).',
      );
    }
    const parsed = demoLoginRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(reply, 400, 'invalid_body', formatIssues(parsed.error.issues));
    }
    if (!constantTimeEqual(parsed.data.accessCode, config.accessCode)) {
      return sendError(reply, 403, 'forbidden', 'Invalid access code.');
    }
    // Phase 5: create/link a Clerk user for the seeded "alex" row and return a
    // Clerk sign-in token (plans/03 §7). Until the seeder exists there is no
    // alex row to link, so this endpoint is a stub.
    return sendError(
      reply,
      501,
      'not_implemented',
      'Demo login activates in Phase 5, once the seeded "alex" user exists. ' +
        'It will then mint a Clerk sign-in token for that account.',
    );
  });
};

function toMeResponse(user: User, onboarded: boolean): MeResponse {
  return {
    id: user.id,
    handle: user.handle,
    displayName: user.displayName,
    timezone: user.timezone,
    onboarded,
  };
}

function formatIssues(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; ');
}
