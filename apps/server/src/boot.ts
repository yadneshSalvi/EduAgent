/**
 * Service wiring (plans/03 §1 boot order): WorkspaceManager + skills →
 * UiToolRelay (listening BEFORE codex spawns, so the first tool call always
 * has a live relay) → AppServerClient (spawn codex with the eduagent-ui MCP
 * registration) → MemoryPipeline → ThreadManager → WsGateway. Shared by
 * src/index.ts and the gated E2Es so tests boot the exact production graph.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { UI_TOOL_NAMES } from '@eduagent/shared';
import { WsGateway } from './api/gateway.js';
import {
  AppServerClient,
  type CodexLogger,
  type ElicitationApprover,
  type HealthProbe,
} from './codex/index.js';
import type { AppConfig } from './config.js';
import { DashboardService, ExamService, ReviewService, TrackService } from './learning/index.js';
import { installedSkillsRoot, SKILL_NAMES } from './prompts/index.js';
import { UiToolRelay } from './relay/index.js';
import { ThreadManager } from './threads/index.js';
import { MemoryPipeline, WorkspaceManager } from './workspace/index.js';

/** The MCP registration name for the ui-tools server (plans/01 §4.5). */
export const UI_TOOLS_SERVER_NAME = 'eduagent-ui';

/**
 * Elicitation policy (PROTOCOL_NOTES §8): auto-accept MCP tool-call approvals
 * only for ui_* tools coming from OUR registered server (Phase 2 carry-over a
 * — the server-name pin keeps a look-alike tool on any other MCP server from
 * riding the allowlist). Everything else is declined and warn-logged.
 */
export const uiToolElicitationApprover: ElicitationApprover = (ctx) =>
  ctx.approvalKind === 'mcp_tool_call' &&
  ctx.serverName === UI_TOOLS_SERVER_NAME &&
  ctx.toolName !== null &&
  ctx.toolName.startsWith('ui_');

export interface AppServices {
  workspaces: WorkspaceManager;
  threads: ThreadManager;
  gateway: WsGateway;
  client: AppServerClient;
  relay: UiToolRelay;
  /** The port the relay actually bound (config.relayPort, or ephemeral in tests). */
  relayPort: number;
  codexHealth: () => Promise<HealthProbe>;
  dashboard: DashboardService;
  review: ReviewService;
  exams: ExamService;
  tracks: TrackService;
}

export interface CreateServicesDeps {
  config: AppConfig;
  prisma: PrismaClient;
  logger: CodexLogger;
}

export async function createServices({
  config,
  prisma,
  logger,
}: CreateServicesDeps): Promise<AppServices> {
  const workspaces = new WorkspaceManager(config, { logger });
  await workspaces.ensureSkillsInstalled();

  const gateway = new WsGateway(logger);

  // Built before the relay: ui_grade_exam computes the exact post-exam
  // readiness snapshot through it (plans/06 Phase 4 task 4).
  const dashboard = new DashboardService({ prisma, workspaces, logger });

  const relay = new UiToolRelay(
    { prisma, sink: gateway, workspaces, dashboard, logger },
    { port: config.relayPort },
  );
  const relayPort = await relay.listen();

  let threads: ThreadManager | null = null;
  const client = new AppServerClient({
    codexBin: config.codexBin,
    defaultModel: config.codexModel,
    logger,
    approveElicitation: uiToolElicitationApprover,
    onRestarted: () => threads?.resumeAll(),
    mcpServers: {
      [UI_TOOLS_SERVER_NAME]: uiToolsServerSpec(config, relayPort),
    },
    // codex 0.144.4 has no ancestor-walk skill discovery — the installed
    // skills root must be registered explicitly (QA finding M2).
    skillsExtraRoots: [installedSkillsRoot(config.dataDir)],
    // Env is pass-through (child inherits process.env); CODEX_HOME narrows
    // codex to a dedicated authenticated home when configured (plans/08 §3).
    ...(config.codexHome ? { env: { CODEX_HOME: config.codexHome } } : {}),
  });
  try {
    await client.start();
    await assertSkillsVisible(client, config, logger);
    await assertUiToolsVisible(client, logger);
  } catch (err) {
    await relay.close();
    throw err;
  }

  const memory = new MemoryPipeline({
    workspaces,
    prisma,
    emitter: gateway,
    logger,
    // The plans/03 §3.4 cache-invalidation hook: every turn that produced
    // memory commits drops that user's cached DashboardData.
    onMemoryChanged: (userId) => dashboard.invalidate(userId),
  });
  threads = new ThreadManager({
    prisma,
    client,
    workspaces,
    memory,
    sink: gateway,
    logger,
    dailyTurnQuota: config.dailyTurnQuota,
  });
  const review = new ReviewService({ prisma, workspaces, threads, logger });
  const tracks = new TrackService({
    prisma,
    workspaces,
    threads,
    memory,
    sink: gateway,
    logger,
  });
  await tracks.sweepStaleGenerating();
  const exams = new ExamService({ prisma, workspaces, threads, dashboard, sink: gateway, logger });
  // Deadline enforcement (plans/03 §3.5): expired in_progress exams
  // auto-submit with their last autosaved answers. app.close() stops it.
  exams.startSweep();

  return {
    workspaces,
    threads,
    gateway,
    client,
    relay,
    relayPort,
    codexHealth: () => client.healthProbe(),
    dashboard,
    review,
    exams,
    tracks,
  };
}

/**
 * The eduagent-ui registration codex spawns (plans/01 §1): node running the
 * mcp-ui-tools TS entry through the tsx CLI (this repo runs all non-bundled
 * TS from source — plans/01 §2), with the relay port in env (`-c
 * mcp_servers.*.env` table rendering verified live, PROTOCOL_NOTES §8).
 */
export function uiToolsServerSpec(
  config: Pick<AppConfig, 'repoRoot'>,
  relayPort: number,
): { command: string; args: string[]; env: Record<string, string> } {
  const require = createRequire(import.meta.url);
  const tsxCli = require.resolve('tsx/cli');
  const entry = path.join(config.repoRoot, 'packages', 'mcp-ui-tools', 'src', 'index.ts');
  return {
    command: process.execPath,
    args: [tsxCli, entry],
    env: { RELAY_PORT: String(relayPort) },
  };
}

/**
 * Boot-time proof that the teach/memory skills actually reach the model:
 * QA finding M2 traced schema-invalid onboarding writes to skills that were
 * installed on disk but invisible to codex. Fail the boot rather than run
 * every tutor without its playbooks.
 */
async function assertSkillsVisible(
  client: AppServerClient,
  config: AppConfig,
  logger: CodexLogger,
): Promise<void> {
  const listed = await client.listSkills([config.dataDir]);
  const visible = new Set(listed.data.flatMap((entry) => entry.skills.map((skill) => skill.name)));
  const missing = SKILL_NAMES.filter((name) => !visible.has(name));
  if (missing.length > 0) {
    throw new Error(
      `codex cannot see the ${missing.join('/')} skill(s) under ${installedSkillsRoot(config.dataDir)} — ` +
        'skills/extraRoots/set failed or the install is missing (see boot logs)',
    );
  }
  logger.info({ skills: SKILL_NAMES }, 'codex skills visible via skills/list');
}

/**
 * Boot-time proof that codex spawned the eduagent-ui MCP server and can list
 * its tools — a broken registration would otherwise surface only as baffling
 * mid-lesson tool failures.
 */
export async function assertUiToolsVisible(
  client: {
    listMcpServerStatus(): Promise<{
      data: Array<{ name: string; tools?: Record<string, unknown> | null }>;
    }>;
  },
  logger: CodexLogger,
): Promise<void> {
  const status = await client.listMcpServerStatus();
  const entry = status.data.find((server) => server.name === UI_TOOLS_SERVER_NAME);
  const toolNames = Object.keys(entry?.tools ?? {});
  const missing = UI_TOOL_NAMES.filter((name) => !toolNames.includes(name));
  if (entry === undefined || missing.length > 0) {
    throw new Error(
      `codex did not report every "${UI_TOOLS_SERVER_NAME}" MCP tool` +
        `${missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''} — ` +
        'check the mcp_servers spawn overrides and the mcp-ui-tools entry (see codex stderr in logs)',
    );
  }
  logger.info({ tools: toolNames }, 'eduagent-ui MCP tools visible via mcpServerStatus/list');
}
