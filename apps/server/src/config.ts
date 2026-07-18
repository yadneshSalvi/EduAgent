import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Absolute path to the repo root (this file lives at apps/server/src/). */
export const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

/** Cookie signing fallback for AUTH_MODE=local dev runs (plans/01 §6). */
export const DEV_SESSION_SECRET = 'eduagent-dev-session-secret-not-for-production';

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  AUTH_MODE: z.enum(['clerk', 'local']).default('clerk'),
  WEB_PORT: z.coerce.number().int().positive().default(3000),
  SERVER_PORT: z.coerce.number().int().positive().default(8787),
  // 0 = bind an ephemeral port (tests); boot passes the ACTUAL bound port to
  // the MCP registration, so nothing else may read this after listen().
  RELAY_PORT: z.coerce.number().int().min(0).default(8788),
  SERVER_HOST: z.string().optional(),
  DATA_DIR: z.string().default('./data'),
  DATABASE_URL: z.string().optional(),
  CODEX_BIN: z.string().default('codex'),
  // Exact id verified by the Phase 0 spike (docs/PROTOCOL_NOTES.md): there is
  // no bare "gpt-5.6" — the model id is "gpt-5.6-sol".
  CODEX_MODEL: z.string().default('gpt-5.6-sol'),
  // Optional dedicated codex home (auth.json via `codex login --with-api-key`,
  // PROTOCOL_NOTES §10). Unset = the child inherits the ambient ~/.codex.
  CODEX_HOME: z.string().optional(),
  SESSION_SECRET: z.string().min(16, 'must be at least 16 characters').default(DEV_SESSION_SECRET),
  ACCESS_CODE: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().optional(),
  APP_ORIGIN: z.url().optional(),
  // Max USER turn starts per profile per local day; 0 = no quota (plans/08 §5).
  DAILY_TURN_QUOTA: z.coerce.number().int().min(0).default(0),
  // "1" enables @fastify/rate-limit (hosted deployments behind Caddy only —
  // the limiter keys on X-Forwarded-For via trustProxy).
  RATE_LIMITS: z.string().optional(),
  LOG_LEVEL: logLevelSchema.optional(),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  authMode: 'clerk' | 'local';
  webPort: number;
  serverPort: number;
  relayPort: number;
  /** Bind address: 127.0.0.1 outside production unless SERVER_HOST overrides. */
  host: string;
  repoRoot: string;
  /** Absolute path; DATA_DIR is resolved against the repo root. */
  dataDir: string;
  /** SQLite URL; defaults to file:<dataDir>/eduagent.db, DATABASE_URL overrides. */
  databaseUrl: string;
  codexBin: string;
  codexModel: string;
  /** Absolute path when set; CODEX_HOME is resolved against the repo root. */
  codexHome?: string;
  sessionSecret: string;
  accessCode?: string;
  clerkSecretKey?: string;
  clerkPublishableKey?: string;
  appOrigin?: string;
  /** Web origins allowed by CORS (credentials mode). */
  corsOrigins: string[];
  /** Max USER turn starts per profile per local day; 0 = quota off. */
  dailyTurnQuota: number;
  /** True when RATE_LIMITS=1 — registers @fastify/rate-limit (prod only). */
  rateLimits: boolean;
  logLevel?: z.infer<typeof logLevelSchema>;
}

/**
 * Loads and validates configuration. Without an explicit `env`, reads the
 * REPO ROOT `.env` (single env file for all three processes, plans/01 §6)
 * and then `process.env`. Pass a record in tests for a hermetic parse.
 */
export function loadConfig(env?: Record<string, string | undefined>): AppConfig {
  const source = env ?? loadRootDotenv();
  // .env lines like `ACCESS_CODE=` yield empty strings — treat them as unset.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value !== ''),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }
  const e = parsed.data;
  const dataDir = path.resolve(repoRoot, e.DATA_DIR);
  return {
    nodeEnv: e.NODE_ENV,
    authMode: e.AUTH_MODE,
    webPort: e.WEB_PORT,
    serverPort: e.SERVER_PORT,
    relayPort: e.RELAY_PORT,
    host: e.SERVER_HOST ?? (e.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'),
    repoRoot,
    dataDir,
    databaseUrl: e.DATABASE_URL ?? `file:${path.join(dataDir, 'eduagent.db')}`,
    codexBin: e.CODEX_BIN,
    codexModel: e.CODEX_MODEL,
    ...(e.CODEX_HOME !== undefined ? { codexHome: path.resolve(repoRoot, e.CODEX_HOME) } : {}),
    sessionSecret: e.SESSION_SECRET,
    accessCode: e.ACCESS_CODE,
    clerkSecretKey: e.CLERK_SECRET_KEY,
    clerkPublishableKey: e.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
    appOrigin: e.APP_ORIGIN,
    corsOrigins: [
      `http://localhost:${e.WEB_PORT}`,
      `http://127.0.0.1:${e.WEB_PORT}`,
      ...(e.APP_ORIGIN ? [e.APP_ORIGIN] : []),
    ],
    dailyTurnQuota: e.DAILY_TURN_QUOTA,
    rateLimits: e.RATE_LIMITS === '1',
    logLevel: e.LOG_LEVEL,
  };
}

function loadRootDotenv(): NodeJS.ProcessEnv {
  dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });
  return process.env;
}

/**
 * Boot-log-safe view of the config: secrets appear ONLY as presence booleans,
 * never as values. Log this, never the config object itself.
 */
export function configSummary(config: AppConfig) {
  return {
    nodeEnv: config.nodeEnv,
    authMode: config.authMode,
    serverPort: config.serverPort,
    relayPort: config.relayPort,
    webPort: config.webPort,
    host: config.host,
    dataDir: config.dataDir,
    databaseUrl: config.databaseUrl,
    codexBin: config.codexBin,
    codexModel: config.codexModel,
    codexHome: config.codexHome,
    corsOrigins: config.corsOrigins,
    dailyTurnQuota: config.dailyTurnQuota,
    rateLimits: config.rateLimits,
    clerkSecretKeySet: config.clerkSecretKey !== undefined,
    clerkPublishableKeySet: config.clerkPublishableKey !== undefined,
    accessCodeSet: config.accessCode !== undefined,
    sessionSecretIsDevDefault: config.sessionSecret === DEV_SESSION_SECRET,
  };
}

/** Where a user's git workspace ("Memory") lives (plans/02 §1). */
export function workspacePathFor(config: AppConfig, userId: string): string {
  return path.join(config.dataDir, 'workspaces', userId);
}
