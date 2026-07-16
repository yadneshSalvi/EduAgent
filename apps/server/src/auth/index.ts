import type { PrismaClient } from '@prisma/client';
import type { AppConfig } from '../config.js';
import { createClerkAuthProvider } from './clerk.js';
import { createLocalAuthProvider } from './local.js';
import type { AuthProvider } from './types.js';

/** Two providers behind one interface, selected by AUTH_MODE (plans/03 §1). */
export function createAuthProvider(config: AppConfig, prisma: PrismaClient): AuthProvider {
  return config.authMode === 'local'
    ? createLocalAuthProvider(prisma)
    : createClerkAuthProvider(config, prisma);
}

export { LOCAL_SESSION_COOKIE } from './local.js';
export type { AuthedUser, AuthProvider } from './types.js';
