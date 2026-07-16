import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import type { PrismaClient } from '@prisma/client';
import { authRoutes } from './api/auth.js';
import { healthRoutes } from './api/health.js';
import { wsRoutes } from './api/ws.js';
import { createAuthProvider, type AuthedUser } from './auth/index.js';
import type { AppConfig } from './config.js';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig;
    prisma: PrismaClient;
    /** Resolves the current user from the request (Clerk JWT or local cookie). */
    resolveUser(req: FastifyRequest): Promise<AuthedUser | null>;
  }
}

export interface BuildAppDeps {
  config: AppConfig;
  prisma: PrismaClient;
}

/**
 * Assembles the Fastify app (plugins → auth decorator → routes). Boot-order
 * concerns that live outside the HTTP app (Prisma connect, codex spawn,
 * listen, shutdown) are src/index.ts's job — this stays test-injectable.
 */
export async function buildApp({ config, prisma }: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions(config) });

  app.decorate('appConfig', config);
  app.decorate('prisma', prisma);
  const authProvider = createAuthProvider(config, prisma);
  app.decorate('resolveUser', (req: FastifyRequest) => authProvider.resolveUser(req));

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(websocket);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(wsRoutes);

  return app;
}

function loggerOptions(config: AppConfig): FastifyServerOptions['logger'] {
  if (config.nodeEnv === 'test') return false;
  const level = config.logLevel ?? 'info';
  if (config.nodeEnv === 'development') {
    return {
      level,
      transport: {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    };
  }
  return { level };
}
