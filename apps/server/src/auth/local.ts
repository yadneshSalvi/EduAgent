import type { PrismaClient } from '@prisma/client';
import type { AuthProvider } from './types.js';

/**
 * AUTH_MODE=local session cookie: httpOnly, signed with SESSION_SECRET via
 * @fastify/cookie, value = the User id. Set by POST /auth/local-login.
 */
export const LOCAL_SESSION_COOKIE = 'eduagent_session';

/**
 * Clerk-free fallback for judge local runs (plans/01 §7): the signed cookie
 * carries the User id directly; a valid signature + an existing row is a login.
 */
export function createLocalAuthProvider(prisma: PrismaClient): AuthProvider {
  return {
    mode: 'local',
    async resolveUser(req) {
      const raw = req.cookies[LOCAL_SESSION_COOKIE];
      if (!raw) return null;
      const unsigned = req.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) return null;
      const user = await prisma.user.findUnique({
        where: { id: unsigned.value },
        select: { id: true },
      });
      return user ? { userId: user.id } : null;
    },
  };
}
