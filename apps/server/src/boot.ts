/**
 * Phase 1 service wiring (plans/03 §3.4 boot order): WorkspaceManager +
 * skills → AppServerClient (spawn codex) → MemoryPipeline → ThreadManager →
 * WsGateway. Shared by src/index.ts and the gated golden-path E2E so the test
 * boots the exact production graph.
 */
import type { PrismaClient } from '@prisma/client';
import { WsGateway } from './api/gateway.js';
import { AppServerClient, type CodexLogger, type ElicitationApprover, type HealthProbe } from './codex/index.js';
import type { AppConfig } from './config.js';
import { installedSkillsRoot, SKILL_NAMES } from './prompts/index.js';
import { ThreadManager } from './threads/index.js';
import { MemoryPipeline, WorkspaceManager } from './workspace/index.js';

/**
 * The MCP registration name the ui-tools server will use (plans/01 §4.5).
 * Phase 2 registers it and pins `ctx.serverName === UI_TOOLS_SERVER_NAME`
 * here; until then no MCP server is registered, so the approvalKind + tool
 * prefix checks are the whole policy.
 */
export const UI_TOOLS_SERVER_NAME = 'eduagent-ui';

export const uiToolElicitationApprover: ElicitationApprover = (ctx) =>
  ctx.approvalKind === 'mcp_tool_call' && ctx.toolName !== null && ctx.toolName.startsWith('ui_');

export interface AppServices {
  workspaces: WorkspaceManager;
  threads: ThreadManager;
  gateway: WsGateway;
  client: AppServerClient;
  codexHealth: () => Promise<HealthProbe>;
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

  let threads: ThreadManager | null = null;
  const client = new AppServerClient({
    codexBin: config.codexBin,
    defaultModel: config.codexModel,
    logger,
    approveElicitation: uiToolElicitationApprover,
    onRestarted: () => threads?.resumeAll(),
    // codex 0.144.4 has no ancestor-walk skill discovery — the installed
    // skills root must be registered explicitly (QA finding M2).
    skillsExtraRoots: [installedSkillsRoot(config.dataDir)],
    // Env is pass-through (child inherits process.env); CODEX_HOME narrows
    // codex to a dedicated authenticated home when configured (plans/08 §3).
    ...(config.codexHome ? { env: { CODEX_HOME: config.codexHome } } : {}),
  });
  await client.start();
  await assertSkillsVisible(client, config, logger);

  const memory = new MemoryPipeline({ workspaces, prisma, emitter: gateway, logger });
  threads = new ThreadManager({ prisma, client, workspaces, memory, sink: gateway, logger });

  return { workspaces, threads, gateway, client, codexHealth: () => client.healthProbe() };
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
  const visible = new Set(
    listed.data.flatMap((entry) => entry.skills.map((skill) => skill.name)),
  );
  const missing = SKILL_NAMES.filter((name) => !visible.has(name));
  if (missing.length > 0) {
    throw new Error(
      `codex cannot see the ${missing.join('/')} skill(s) under ${installedSkillsRoot(config.dataDir)} — ` +
        'skills/extraRoots/set failed or the install is missing (see boot logs)',
    );
  }
  logger.info({ skills: SKILL_NAMES }, 'codex skills visible via skills/list');
}
