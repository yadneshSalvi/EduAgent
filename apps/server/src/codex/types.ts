/**
 * Shapes for the AppServerClient protocol layer. Everything wire-facing is
 * locked to the generated protocol types (`@eduagent/shared/protocol`, emitted
 * by `codex app-server generate-ts`) and to docs/PROTOCOL_NOTES.md — per
 * plans/03 §2 this module is the only one allowed to import protocol shapes.
 */
import type { Readable, Writable } from 'node:stream';
import type {
  ClientInfo,
  InitializeParams,
  InitializeResponse,
  ReasoningEffort,
  ReasoningSummary,
  v2,
} from '@eduagent/shared/protocol';

/**
 * Structural copy of the generated `serde_json/JsonValue` (that file is not
 * re-exported from the generated index); assignable in both directions.
 */
export type JsonValue =
  | number
  | string
  | boolean
  | Array<JsonValue>
  | { [key in string]?: JsonValue }
  | null;

/**
 * The methods this host calls, with wire-observed params/results
 * (PROTOCOL_NOTES §3). Extend here — never call with guessed shapes.
 */
export interface AppServerMethods {
  initialize: { params: InitializeParams; result: InitializeResponse };
  'thread/start': { params: v2.ThreadStartParams; result: v2.ThreadStartResponse };
  'thread/resume': { params: v2.ThreadResumeParams; result: v2.ThreadResumeResponse };
  'thread/fork': { params: v2.ThreadForkParams; result: v2.ThreadForkResponse };
  'turn/start': { params: v2.TurnStartParams; result: v2.TurnStartResponse };
  'turn/interrupt': { params: v2.TurnInterruptParams; result: v2.TurnInterruptResponse };
  'model/list': { params: v2.ModelListParams; result: v2.ModelListResponse };
  'skills/list': { params: v2.SkillsListParams; result: v2.SkillsListResponse };
  'skills/extraRoots/set': {
    params: v2.SkillsExtraRootsSetParams;
    result: v2.SkillsExtraRootsSetResponse;
  };
  'account/read': { params: v2.GetAccountParams; result: v2.GetAccountResponse };
  'mcpServerStatus/list': {
    params: v2.ListMcpServerStatusParams;
    result: v2.ListMcpServerStatusResponse;
  };
}

export type AppServerMethodName = keyof AppServerMethods;

/** Any notification as it arrived on the wire. */
export interface RawNotification {
  method: string;
  params: unknown;
}

/**
 * Thread-scoped events mapped from server notifications (PROTOCOL_NOTES §4).
 * Unknown notifications that carry a `threadId` pass through as `raw`;
 * `turnAborted` is synthesized locally when the child dies mid-turn.
 */
export type ThreadEvent =
  | ({ type: 'threadStatusChanged' } & v2.ThreadStatusChangedNotification)
  | ({ type: 'tokenUsageUpdated' } & v2.ThreadTokenUsageUpdatedNotification)
  | ({ type: 'turnStarted' } & v2.TurnStartedNotification)
  | ({ type: 'turnCompleted' } & v2.TurnCompletedNotification)
  | ({ type: 'turnDiffUpdated' } & v2.TurnDiffUpdatedNotification)
  | ({ type: 'turnPlanUpdated' } & v2.TurnPlanUpdatedNotification)
  | ({ type: 'itemStarted' } & v2.ItemStartedNotification)
  | ({ type: 'itemCompleted' } & v2.ItemCompletedNotification)
  | ({ type: 'agentMessageDelta' } & v2.AgentMessageDeltaNotification)
  | ({ type: 'commandOutputDelta' } & v2.CommandExecutionOutputDeltaNotification)
  | ({ type: 'reasoningSummaryPartAdded' } & v2.ReasoningSummaryPartAddedNotification)
  | ({ type: 'reasoningSummaryDelta' } & v2.ReasoningSummaryTextDeltaNotification)
  | ({ type: 'reasoningTextDelta' } & v2.ReasoningTextDeltaNotification)
  | {
      type: 'turnAborted';
      threadId: string;
      turnId: string;
      error: { message: string; retryable: true };
    }
  | { type: 'raw'; threadId: string; method: string; params: unknown };

export type ThreadEventType = ThreadEvent['type'];

export type ThreadEventListener = (event: ThreadEvent) => void;

/** Events emitted by AppServerClient (typed EventEmitter map). */
export interface AppServerClientEventMap {
  /** Every server notification, raw, before mapping. */
  notification: [RawNotification];
  /** Every mapped thread-scoped event (also fanned out to onThreadEvent subscribers). */
  threadEvent: [ThreadEvent];
  /** Every server→client request, raw, after it has been answered. */
  serverRequest: [{ method: string; params: unknown }];
  /** Child died unexpectedly (before any auto-restart completes). */
  exit: [{ code: number | null; signal: NodeJS.Signals | null }];
  /** Auto-restart finished its handshake; ThreadManager re-resumes threads. */
  restarted: [];
}

/** pino-compatible structural logger (fastify's `app.log` satisfies this). */
export interface CodexLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** One MCP server registration, rendered as `-c mcp_servers.*` spawn args (PROTOCOL_NOTES §8). */
export interface McpServerSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/** What the elicitation approver sees for each `mcpServer/elicitation/request`. */
export interface ElicitationContext {
  threadId: string;
  turnId: string | null;
  serverName: string;
  /**
   * Parsed from the human-readable message (`… run tool "ui_push_quiz"?`) —
   * the observed wire carries no structured tool-name field (fixture 08).
   */
  toolName: string | null;
  /** `_meta.codex_approval_kind`, e.g. "mcp_tool_call". */
  approvalKind: string | null;
  params: v2.McpServerElicitationRequestParams;
}

export type ElicitationApprover = (ctx: ElicitationContext) => boolean;

export interface BackoffOptions {
  /** First restart delay in ms (default 500). */
  initialMs?: number;
  /** Multiplier per consecutive crash (default 2). */
  factor?: number;
  /** Delay cap in ms (default 30_000). */
  maxMs?: number;
  /** Uptime after which the crash counter resets (default 30_000). */
  stableMs?: number;
}

/** Minimal structural view of the spawned child; `node:child_process` satisfies it. */
export interface AppServerChildProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  pid?: number | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

export type SpawnAppServer = (
  bin: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => AppServerChildProcess;

export interface AppServerClientOptions {
  /** `config.codexBin` — spawned as `${codexBin} app-server`. */
  codexBin: string;
  /** `config.codexModel` — passed on thread/start and every turn/start. */
  defaultModel: string;
  /** Per-turn reasoning effort (default "medium" — enables summary streams, PROTOCOL_NOTES §12). */
  defaultEffort?: ReasoningEffort;
  /** Per-turn reasoning summary (default "detailed" — PROTOCOL_NOTES D7). */
  defaultSummary?: ReasoningSummary;
  clientInfo?: ClientInfo;
  /** Rendered into `-c mcp_servers.<name>.*` CLI overrides at spawn (Phase 2 supplies values). */
  mcpServers?: Record<string, McpServerSpec>;
  /** Decides MCP tool-call elicitations; default accepts `ui_*` tool calls only. */
  approveElicitation?: ElicitationApprover;
  /**
   * Skill roots registered via `skills/extraRoots/set` after every (re)spawn
   * handshake. Required for $DATA_DIR/.codex/skills: codex 0.144.4 does NOT
   * ancestor-walk from the thread cwd (Phase 1 QA finding M2 — without this
   * the teach/memory skills are invisible to the model).
   */
  skillsExtraRoots?: string[];
  /** Called after an auto-restart handshake succeeds (ThreadManager re-resumes threads). */
  onRestarted?: () => void | Promise<void>;
  logger?: CodexLogger;
  backoff?: BackoffOptions;
  /** Extra env for the child (e.g. CODEX_HOME), merged over process.env. */
  env?: Record<string, string>;
  /** Test seam; defaults to node:child_process spawn. */
  spawnFn?: SpawnAppServer;
  /** SIGKILL grace period after SIGTERM on close() (default 3000ms). */
  killTimeoutMs?: number;
}

export interface StartThreadOptions {
  /** The user's workspace dir — the thread's cwd and sandbox root. */
  cwd: string;
  /** Mode template + session token (thread-level only — PROTOCOL_NOTES D2). */
  developerInstructions?: string;
  model?: string;
}

export interface ResumeThreadOptions {
  threadId: string;
  cwd?: string;
  /** Pass to rotate mode context/session token on resume (PROTOCOL_NOTES D2). */
  developerInstructions?: string;
  model?: string;
}

export interface ForkThreadOptions {
  threadId: string;
  /** Fork through this turn id, inclusive. */
  lastTurnId?: string;
  cwd?: string;
  developerInstructions?: string;
  model?: string;
}

export interface StartTurnOptions {
  model?: string;
  effort?: ReasoningEffort;
  summary?: ReasoningSummary;
  cwd?: string;
  /** Extra sandbox-writable roots beyond the thread cwd. */
  writableRoots?: string[];
  /** JSON schema constraining the final assistant message. */
  outputSchema?: JsonValue;
  clientUserMessageId?: string;
}

/** Result of healthProbe() — feeds the /healthz codex check (wired in task #11). */
export interface HealthProbe {
  /** running && authenticated. */
  ok: boolean;
  /** Child alive and handshake completed. */
  running: boolean;
  /** `account/read` reports auth present (PROTOCOL_NOTES §10). */
  authenticated: boolean;
  /** e.g. "apiKey" | "chatgpt" when an account is present. */
  authMode: string | null;
  /** Human-readable failure detail when not ok. */
  detail?: string;
}
