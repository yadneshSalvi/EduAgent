import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { ApiError } from '@eduagent/shared';

/** Sends the shared error envelope (`apiErrorSchema` in @eduagent/shared). */
export function sendError(
  reply: FastifyReply,
  status: number,
  error: string,
  message?: string,
): FastifyReply {
  const body: ApiError = message === undefined ? { error } : { error, message };
  return reply.code(status).send(body);
}

/** Length-hiding constant-time string comparison (access-code checks). */
export function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a).digest();
  const digestB = createHash('sha256').update(b).digest();
  return timingSafeEqual(digestA, digestB);
}
