import { randomUUID } from 'node:crypto';
import { verifyToken } from '@clerk/backend';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import { workspacePathFor, type AppConfig } from '../config.js';
import type { AuthProvider } from './types.js';

type VerifiedClaims = Awaited<ReturnType<typeof verifyToken>>;

/**
 * Verifies Clerk session JWTs (Authorization bearer or the `__session`
 * cookie Clerk sets on the web origin) via @clerk/backend. Verification is
 * signature-based against Clerk's JWKS — fetched once and cached by the SDK,
 * so steady-state requests stay networkless. Unknown Clerk user ids are
 * auto-provisioned as User rows on first sight (plans/02 §5).
 */
export function createClerkAuthProvider(config: AppConfig, prisma: PrismaClient): AuthProvider {
  const secretKey = config.clerkSecretKey;
  if (!secretKey) {
    throw new Error(
      'AUTH_MODE=clerk requires CLERK_SECRET_KEY in the repo-root .env ' +
        '(set AUTH_MODE=local for a Clerk-free local run)',
    );
  }

  return {
    mode: 'clerk',
    async resolveUser(req) {
      const token = sessionTokenFrom(req);
      if (!token) return null;

      let claims: VerifiedClaims;
      try {
        claims = await verifyToken(token, { secretKey });
      } catch (err) {
        req.log.debug({ err }, 'Clerk session verification failed');
        return null;
      }
      if (!claims.sub) return null;

      const existing = await prisma.user.findUnique({
        where: { authId: claims.sub },
        select: { id: true },
      });
      if (existing) return { userId: existing.id };

      const created = await provisionUser(config, prisma, claims);
      req.log.info({ userId: created.id }, 'auto-provisioned user for new Clerk id');
      return { userId: created.id };
    },
  };
}

function sessionTokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice('Bearer '.length).trim();
    if (token) return token;
  }
  return req.cookies['__session'] ?? null;
}

/**
 * First sight of a Clerk user id: create the User row. Handle is derived from
 * claims (username, then email local part) and made unique with a numeric
 * suffix; displayName falls back to the handle when claims carry no name.
 */
async function provisionUser(
  config: AppConfig,
  prisma: PrismaClient,
  claims: VerifiedClaims,
): Promise<{ id: string }> {
  const authId = claims.sub;
  const handleBase = deriveHandle(claims);
  const displayName = deriveDisplayName(claims) ?? handleBase;

  for (let attempt = 0; attempt < 10; attempt++) {
    const handle = attempt === 0 ? handleBase : `${handleBase}-${attempt + 1}`;
    const id = randomUUID();
    try {
      return await prisma.user.create({
        data: { id, authId, handle, displayName, workspacePath: workspacePathFor(config, id) },
        select: { id: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Concurrent request may have provisioned this Clerk user already.
        const raced = await prisma.user.findUnique({ where: { authId }, select: { id: true } });
        if (raced) return raced;
        continue; // handle collision — try the next suffix
      }
      throw err;
    }
  }
  throw new Error(`could not derive a unique handle for new Clerk user (base "${handleBase}")`);
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function deriveHandle(claims: VerifiedClaims): string {
  const record = claims as Record<string, unknown>;
  for (const key of ['username', 'preferred_username']) {
    const value = record[key];
    if (typeof value === 'string') {
      const slug = slugifyHandle(value);
      if (slug) return slug;
    }
  }
  const email = record['email'];
  if (typeof email === 'string' && email.includes('@')) {
    const slug = slugifyHandle(email.slice(0, email.indexOf('@')));
    if (slug) return slug;
  }
  const tail = claims.sub
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(-8);
  return tail ? `user-${tail}` : 'user';
}

function slugifyHandle(raw: string): string | null {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z0-9][a-z0-9-]*$/.test(slug) ? slug : null;
}

function deriveDisplayName(claims: VerifiedClaims): string | null {
  const record = claims as Record<string, unknown>;
  const name = record['name'];
  if (typeof name === 'string' && name.trim()) return name.trim();
  const parts = [record['first_name'], record['last_name']].filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  return parts.length > 0 ? parts.join(' ') : null;
}
