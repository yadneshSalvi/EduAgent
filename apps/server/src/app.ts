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
import type { WsGateway } from './api/gateway.js';
import { healthRoutes } from './api/health.js';
import { threadRoutes } from './api/threads.js';
import { wsRoutes } from './api/ws.js';
import { createAuthProvider, type AuthedUser } from './auth/index.js';
import type { HealthProbe } from './codex/index.js';
import type { AppConfig } from './config.js';
import type { ThreadService } from './threads/index.js';
import type { WorkspaceManager } from './workspace/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    appConfig: AppConfig;
    prisma: PrismaClient;
    /** Resolves the current user from the request (Clerk JWT or local cookie). */
    resolveUser(req: FastifyRequest): Promise<AuthedUser | null>;
    /** Phase 1 services — absent when boot ran without codex (some tests). */
    workspaces?: WorkspaceManager;
    threads?: ThreadService;
    wsGateway?: WsGateway;
    codexHealth?: () => Promise<HealthProbe>;
  }
}

/** What buildApp decorates onto the instance; tests may inject fakes. */
export interface AppServiceSet {
  workspaces?: WorkspaceManager;
  threads?: ThreadService;
  gateway?: WsGateway;
  codexHealth?: () => Promise<HealthProbe>;
  /** When present, closed on app.close() (terminates the codex child). */
  client?: { close(): Promise<void> };
}

export interface BuildAppDeps {
  config: AppConfig;
  prisma: PrismaClient;
  /**
   * Phase 1 services, or a factory receiving the app (for its logger) —
   * src/index.ts passes createServices from boot.ts. Omitted in service-less
   * tests: thread routes then 503 and WS gateways close(1013).
   */
  services?: AppServiceSet | ((app: FastifyInstance) => Promise<AppServiceSet> | AppServiceSet);
}

/**
 * Assembles the Fastify app (plugins → auth decorator → services → routes).
 * Boot-order concerns outside the HTTP app (Prisma connect, listen, process
 * signals) are src/index.ts's job — this stays test-injectable.
 */
export async function buildApp({ config, prisma, services }: BuildAppDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: loggerOptions(config) });

  app.decorate('appConfig', config);
  app.decorate('prisma', prisma);
  const authProvider = createAuthProvider(config, prisma);
  app.decorate('resolveUser', (req: FastifyRequest) => authProvider.resolveUser(req));

  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(cors, { origin: config.corsOrigins, credentials: true });
  await app.register(websocket);

  const resolved = typeof services === 'function' ? await services(app) : services;
  if (resolved) {
    if (resolved.workspaces) app.decorate('workspaces', resolved.workspaces);
    if (resolved.threads) app.decorate('threads', resolved.threads);
    if (resolved.gateway) app.decorate('wsGateway', resolved.gateway);
    if (resolved.codexHealth) app.decorate('codexHealth', resolved.codexHealth);
    const client = resolved.client;
    if (client) {
      app.addHook('onClose', async () => {
        await client.close();
      });
    }
  }

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(threadRoutes);
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
