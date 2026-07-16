import type { FastifyRequest } from 'fastify';

export interface AuthedUser {
  userId: string;
}

/**
 * The single auth abstraction (plans/01 §7, plans/03 §1): every REST call and
 * WS upgrade resolves the current user through one of these. `null` means
 * unauthenticated — routes translate that to a 401 (or a 4401 WS close).
 */
export interface AuthProvider {
  readonly mode: 'clerk' | 'local';
  resolveUser(req: FastifyRequest): Promise<AuthedUser | null>;
}
