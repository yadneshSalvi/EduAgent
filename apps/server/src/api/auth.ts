import { randomUUID } from 'node:crypto';
import type { User } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import {
  demoLoginRequestSchema,
  localLoginRequestSchema,
  type DemoLoginResponse,
  type LocalUsersResponse,
  type MeResponse,
} from '@eduagent/shared';
import { createDemoClerkClient, LOCAL_SESSION_COOKIE } from '../auth/index.js';
import { workspacePathFor } from '../config.js';
import { constantTimeEqual, sendError } from './http.js';

/** The seeded demo profile demo-login signs judges into (plans/08 §6). */
export const DEMO_HANDLE = 'alex';
/** Sign-in token TTL — long enough to paste-and-click, short enough to leak safely. */
export const DEMO_TOKEN_TTL_SECONDS = 600;

/**
 * Tight per-IP bucket for the CREDENTIAL routes (access-code / handle login):
 * brute-force protection under RATE_LIMITS=1, inert otherwise. Deliberately
 * NOT on /auth/me — the web checks the session on every mount, so 10/min
 * there would 429 normal navigation.
 */
const AUTH_RATE_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

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

  app.post('/auth/local-login', AUTH_RATE_LIMIT, async (req, reply) => {
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

  app.post('/auth/demo-login', AUTH_RATE_LIMIT, async (req, reply) => {
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

    const alex = await prisma.user.findUnique({ where: { handle: DEMO_HANDLE } });
    if (!alex) {
      return sendError(
        reply,
        404,
        'no_demo_user',
        `The seeded "${DEMO_HANDLE}" profile does not exist — run \`pnpm seed\` first.`,
      );
    }

    try {
      const clerkUserId = alex.authId ?? (await ensureClerkLink(alex.id));
      const minted = await demoClerk().createSignInToken({
        userId: clerkUserId,
        expiresInSeconds: DEMO_TOKEN_TTL_SECONDS,
      });
      req.log.info({ userId: alex.id, clerkUserId }, 'demo-login minted sign-in token');
      const response: DemoLoginResponse = { token: minted.token, userId: clerkUserId };
      return response;
    } catch (err) {
      req.log.error({ err, userId: alex.id }, 'demo-login: Clerk API call failed');
      return sendError(
        reply,
        502,
        'clerk_unavailable',
        'Clerk did not accept the sign-in token request. Try again in a moment.',
      );
    }
  });

  /** Lazily built so tests can inject a fake and local mode never touches Clerk. */
  function demoClerk() {
    if (app.demoClerk) return app.demoClerk;
    if (!config.clerkSecretKey) {
      // Unreachable behind the authMode gate (clerk mode refuses to boot
      // without the key) — kept as a guard for direct handler tests.
      throw new Error('demo-login needs CLERK_SECRET_KEY');
    }
    return createDemoClerkClient(config.clerkSecretKey);
  }

  /**
   * First demo-login ever: create the Clerk user for the seeded row and link
   * it (User.authId). Serialized in-process, and the DB write is conditional
   * on authId still being null — a concurrent writer's link wins and our
   * freshly created Clerk user is simply never referenced again. Returns the
   * linked Clerk user id.
   */
  let pendingLink: Promise<string> | null = null;
  function ensureClerkLink(alexRowId: string): Promise<string> {
    pendingLink ??= linkDemoUser(alexRowId).finally(() => {
      pendingLink = null;
    });
    return pendingLink;
  }

  async function linkDemoUser(alexRowId: string): Promise<string> {
    const row = await prisma.user.findUniqueOrThrow({ where: { id: alexRowId } });
    if (row.authId) return row.authId;
    // A fresh/reseeded DATABASE against a Clerk instance that already has the
    // standing demo user (unique demo email) must relink, not re-create.
    const clerk = demoClerk();
    const created =
      (await clerk.findDemoUser({ handle: row.handle })) ??
      (await clerk.createDemoUser({ handle: row.handle, displayName: row.displayName }));
    const linked = await prisma.user.updateMany({
      where: { id: row.id, authId: null },
      data: { authId: created.id },
    });
    if (linked.count === 0) {
      const raced = await prisma.user.findUniqueOrThrow({ where: { id: row.id } });
      if (raced.authId) return raced.authId;
      throw new Error(`could not link Clerk user ${created.id} to demo row ${row.id}`);
    }
    app.log.info({ userId: row.id, clerkUserId: created.id }, 'demo user linked to new Clerk user');
    return created.id;
  }
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
