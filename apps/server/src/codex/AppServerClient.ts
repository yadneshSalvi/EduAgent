/**
 * AppServerClient — the typed protocol layer over a `codex app-server` child
 * (plans/03 §2). Thin, zero business logic. Wire behavior is locked to
 * docs/PROTOCOL_NOTES.md: JSONL over stdio, JSON-RPC 2.0 shapes WITHOUT the
 * "jsonrpc" field, server→client requests that MUST be answered (§8).
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ClientInfo, v2 } from '@eduagent/shared/protocol';
import { AppServerConnectionError, AppServerRequestError } from './errors.js';
import { buildElicitationContext, defaultElicitationApprover } from './elicitation.js';
import { renderMcpConfigArgs } from './mcp-args.js';
import type {
  AppServerChildProcess,
  AppServerClientEventMap,
  AppServerClientOptions,
  AppServerMethodName,
  AppServerMethods,
  CodexLogger,
  ElicitationApprover,
  ForkThreadOptions,
  HealthProbe,
  ResumeThreadOptions,
  SpawnAppServer,
  StartThreadOptions,
  StartTurnOptions,
  ThreadEvent,
  ThreadEventListener,
} from './types.js';

/** The per-turn sandbox EduAgent always runs with (PROTOCOL_NOTES §6, D4). */
const SANDBOX_POLICY_BASE = {
  type: 'workspaceWrite',
  networkAccess: false,
  // Mandatory: workspaceWrite DEFAULTS to /tmp and $TMPDIR being writable.
  excludeSlashTmp: true,
  excludeTmpdirEnvVar: true,
} as const;

const DEFAULT_CLIENT_INFO: ClientInfo = { name: 'eduagent', title: 'EduAgent', version: '0.1.0' };

/** notification method → ThreadEvent discriminator (PROTOCOL_NOTES §4). */
const THREAD_EVENT_TYPES: Record<string, Exclude<ThreadEvent['type'], 'raw' | 'turnAborted'>> = {
  'thread/status/changed': 'threadStatusChanged',
  'thread/tokenUsage/updated': 'tokenUsageUpdated',
  'turn/started': 'turnStarted',
  'turn/completed': 'turnCompleted',
  'turn/diff/updated': 'turnDiffUpdated',
  'turn/plan/updated': 'turnPlanUpdated',
  'item/started': 'itemStarted',
  'item/completed': 'itemCompleted',
  'item/agentMessage/delta': 'agentMessageDelta',
  'item/commandExecution/outputDelta': 'commandOutputDelta',
  'item/reasoning/summaryPartAdded': 'reasoningSummaryPartAdded',
  'item/reasoning/summaryTextDelta': 'reasoningSummaryDelta',
  'item/reasoning/textDelta': 'reasoningTextDelta',
};

const NOOP_LOGGER: CodexLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface WireMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type ClientState = 'idle' | 'starting' | 'running' | 'restarting' | 'closed';

const defaultSpawn: SpawnAppServer = (bin, args, options) =>
  spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env });

export class AppServerClient extends EventEmitter<AppServerClientEventMap> {
  private readonly codexBin: string;
  private readonly defaultModel: string;
  private readonly defaultEffort: string;
  private readonly defaultSummary: v2.TurnStartParams['summary'];
  private readonly clientInfo: ClientInfo;
  private readonly spawnArgs: string[];
  private readonly skillsExtraRoots: string[];
  private readonly approveElicitation: ElicitationApprover;
  private readonly onRestarted?: () => void | Promise<void>;
  private readonly log: CodexLogger;
  private readonly backoff: { initialMs: number; factor: number; maxMs: number; stableMs: number };
  private readonly childEnv?: Record<string, string>;
  private readonly spawnFn: SpawnAppServer;
  private readonly killTimeoutMs: number;

  private state: ClientState = 'idle';
  private child: AppServerChildProcess | null = null;
  private everStarted = false;
  private spawnedAt = 0;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private restartAttempts = 0;
  private restartTimer: NodeJS.Timeout | null = null;
  /** threadId → in-flight turn ids, so a child crash can fail them (plans/03 §8). */
  private activeTurns = new Map<string, Set<string>>();
  private threadSubscribers = new Map<string, Set<ThreadEventListener>>();

  constructor(options: AppServerClientOptions) {
    super();
    this.codexBin = options.codexBin;
    this.defaultModel = options.defaultModel;
    this.defaultEffort = options.defaultEffort ?? 'medium';
    this.defaultSummary = options.defaultSummary ?? 'detailed';
    this.clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;
    this.spawnArgs = ['app-server', ...renderMcpConfigArgs(options.mcpServers)];
    this.skillsExtraRoots = options.skillsExtraRoots ?? [];
    this.approveElicitation = options.approveElicitation ?? defaultElicitationApprover;
    this.onRestarted = options.onRestarted;
    this.log = options.logger ?? NOOP_LOGGER;
    this.backoff = {
      initialMs: options.backoff?.initialMs ?? 500,
      factor: options.backoff?.factor ?? 2,
      maxMs: options.backoff?.maxMs ?? 30_000,
      stableMs: options.backoff?.stableMs ?? 30_000,
    };
    this.childEnv = options.env;
    this.spawnFn = options.spawnFn ?? defaultSpawn;
    this.killTimeoutMs = options.killTimeoutMs ?? 3_000;
  }

  /** True once the initialize/initialized handshake has completed. */
  get isRunning(): boolean {
    return this.state === 'running';
  }

  /**
   * Spawns the child and performs the initialize/initialized handshake
   * (PROTOCOL_NOTES §2). An initial-start failure throws and does NOT
   * auto-restart (a misconfigured boot should fail loudly); deaths after a
   * successful start are auto-restarted with capped exponential backoff.
   */
  async start(): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`AppServerClient.start() called in state "${this.state}"`);
    }
    await this.spawnAndHandshake();
  }

  /** Terminates the child (SIGTERM, then SIGKILL after killTimeoutMs) and disables restarts. */
  async close(): Promise<void> {
    this.state = 'closed';
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child === null) {
      this.rejectAllPending('client closed');
      return;
    }
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
    });
    child.kill('SIGTERM');
    const killTimer = setTimeout(() => child.kill('SIGKILL'), this.killTimeoutMs);
    killTimer.unref?.();
    await exited;
    clearTimeout(killTimer);
  }

  // ---------------------------------------------------------------- requests

  /** Typed request/response over the JSONL wire, correlated by id. */
  request<M extends AppServerMethodName>(
    method: M,
    params: AppServerMethods[M]['params'],
  ): Promise<AppServerMethods[M]['result']> {
    if (this.state !== 'running') {
      return Promise.reject(
        new AppServerConnectionError(
          `codex app-server is not ready (state: ${this.state}) — cannot send ${method}`,
        ),
      );
    }
    return this.sendRequest(method, params) as Promise<AppServerMethods[M]['result']>;
  }

  /** Escape hatch for methods not yet in AppServerMethods. Same guard rails. */
  requestUntyped(method: string, params: unknown): Promise<unknown> {
    if (this.state !== 'running') {
      return Promise.reject(
        new AppServerConnectionError(
          `codex app-server is not ready (state: ${this.state}) — cannot send ${method}`,
        ),
      );
    }
    return this.sendRequest(method, params);
  }

  /** Fire-and-forget notification (client → server). */
  notify(method: string, params: unknown): void {
    this.send({ method, params });
  }

  // ---------------------------------------------------- convenience wrappers

  /** `thread/start` with EduAgent's fixed sandbox/approval posture (fixture 03). */
  startThread(opts: StartThreadOptions): Promise<v2.ThreadStartResponse> {
    return this.request('thread/start', {
      cwd: opts.cwd,
      model: opts.model ?? this.defaultModel,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      developerInstructions: opts.developerInstructions ?? null,
    });
  }

  /** `thread/resume` — also how mode context/session tokens rotate (PROTOCOL_NOTES D2). */
  resumeThread(opts: ResumeThreadOptions): Promise<v2.ThreadResumeResponse> {
    const params: v2.ThreadResumeParams = { threadId: opts.threadId };
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.model !== undefined) params.model = opts.model;
    if (opts.developerInstructions !== undefined) {
      params.developerInstructions = opts.developerInstructions;
    }
    return this.request('thread/resume', params);
  }

  /** `thread/fork` — new thread id, full parent history (exam mode). */
  forkThread(opts: ForkThreadOptions): Promise<v2.ThreadForkResponse> {
    const params: v2.ThreadForkParams = { threadId: opts.threadId };
    if (opts.lastTurnId !== undefined) params.lastTurnId = opts.lastTurnId;
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.model !== undefined) params.model = opts.model;
    if (opts.developerInstructions !== undefined) {
      params.developerInstructions = opts.developerInstructions;
    }
    return this.request('thread/fork', params);
  }

  /**
   * `turn/start`. ALWAYS pins the workspace-write sandbox (with the mandatory
   * /tmp excludes), `approvalPolicy:"never"`, and model/effort/summary
   * defaults. Resolves immediately with the turn id (PROTOCOL_NOTES D11);
   * completion arrives as a `turnCompleted` thread event.
   */
  async startTurn(
    threadId: string,
    input: string | v2.UserInput[],
    opts: StartTurnOptions = {},
  ): Promise<v2.TurnStartResponse> {
    const userInput: v2.UserInput[] =
      typeof input === 'string' ? [{ type: 'text', text: input, text_elements: [] }] : input;
    const params: v2.TurnStartParams = {
      threadId,
      input: userInput,
      sandboxPolicy: { ...SANDBOX_POLICY_BASE, writableRoots: opts.writableRoots ?? [] },
      approvalPolicy: 'never',
      model: opts.model ?? this.defaultModel,
      effort: opts.effort ?? this.defaultEffort,
      summary: opts.summary ?? this.defaultSummary,
    };
    if (opts.cwd !== undefined) params.cwd = opts.cwd;
    if (opts.outputSchema !== undefined) params.outputSchema = opts.outputSchema;
    if (opts.clientUserMessageId !== undefined) {
      params.clientUserMessageId = opts.clientUserMessageId;
    }
    const response = await this.request('turn/start', params);
    this.trackTurn(threadId, response.turn.id);
    return response;
  }

  /** `turn/interrupt`; the turn then completes with status "interrupted" (fixture 10). */
  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request('turn/interrupt', { threadId, turnId });
  }

  listModels(limit = 100): Promise<v2.ModelListResponse> {
    return this.request('model/list', { limit });
  }

  listSkills(cwds: string[], forceReload = true): Promise<v2.SkillsListResponse> {
    return this.request('skills/list', { cwds, forceReload });
  }

  readAccount(): Promise<v2.GetAccountResponse> {
    return this.request('account/read', {});
  }

  listMcpServerStatus(): Promise<v2.ListMcpServerStatusResponse> {
    return this.request('mcpServerStatus/list', {});
  }

  /**
   * Liveness + auth probe for /healthz (PROTOCOL_NOTES §10: env-only auth
   * shows `{account:null, requiresOpenaiAuth:true}`). Never throws.
   */
  async healthProbe(): Promise<HealthProbe> {
    if (this.state !== 'running') {
      return {
        ok: false,
        running: false,
        authenticated: false,
        authMode: null,
        detail: `app-server not running (state: ${this.state})`,
      };
    }
    try {
      const account = await this.readAccount();
      // Observed on 0.144.4: with API-key auth the result is
      // {account:{type:"apiKey"}, requiresOpenaiAuth:true} — requiresOpenaiAuth
      // describes the provider, NOT missing auth. `account:null` is the
      // unauthenticated signal (PROTOCOL_NOTES §10 env-only capture).
      const authenticated = account.account !== null;
      return {
        ok: authenticated,
        running: true,
        authenticated,
        authMode: account.account?.type ?? null,
        ...(authenticated
          ? {}
          : { detail: 'codex is not authenticated — run `codex login --with-api-key` (PROTOCOL_NOTES §10)' }),
      };
    } catch (err) {
      return {
        ok: false,
        running: this.state === 'running',
        authenticated: false,
        authMode: null,
        detail: `account/read failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // ------------------------------------------------------------------ events

  /**
   * Subscribes to mapped events for one thread. Returns an unsubscribe
   * function. Unknown notifications carrying this threadId arrive as
   * `{type:"raw"}` passthroughs.
   */
  onThreadEvent(threadId: string, listener: ThreadEventListener): () => void {
    let set = this.threadSubscribers.get(threadId);
    if (set === undefined) {
      set = new Set();
      this.threadSubscribers.set(threadId, set);
    }
    set.add(listener);
    return () => {
      const current = this.threadSubscribers.get(threadId);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.threadSubscribers.delete(threadId);
    };
  }

  // ------------------------------------------------------------ child mgmt

  private async spawnAndHandshake(): Promise<void> {
    this.state = 'starting';
    this.spawnedAt = Date.now();
    this.stdoutBuffer = '';
    const child = this.spawnFn(this.codexBin, this.spawnArgs, {
      env: { ...process.env, ...this.childEnv },
    });
    this.child = child;
    this.log.info({ bin: this.codexBin, args: this.spawnArgs, pid: child.pid }, 'codex app-server spawned');

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (this.child !== child) return; // stale child still flushing
      this.onStdout(String(chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.log.debug({ stderr: String(chunk).trimEnd() }, 'codex app-server stderr');
    });

    let deathReported = false;
    const reportDeath = (
      code: number | null,
      signal: NodeJS.Signals | null,
      err?: Error,
    ): void => {
      if (deathReported) return;
      deathReported = true;
      this.handleChildDeath(child, code, signal, err);
    };
    child.on('exit', (code, signal) => reportDeath(code, signal));
    child.on('error', (err) => reportDeath(null, null, err));

    const init = await this.sendRequest('initialize', {
      clientInfo: this.clientInfo,
      capabilities: null,
    });
    this.notify('initialized', {});
    this.state = 'running';
    this.everStarted = true;
    this.log.info(init, 'codex app-server handshake complete');

    // Server-global skill roots, re-applied on every (re)spawn. codex 0.144.4
    // does NOT ancestor-walk from thread cwds, so without this the skills at
    // $DATA_DIR/.codex/skills never reach the model (QA finding M2). A failure
    // here is logged, not thrown: boot verifies visibility via skills/list and
    // fails loudly there; a restart-path failure degrades prompts, not turns.
    if (this.skillsExtraRoots.length > 0) {
      try {
        await this.sendRequest('skills/extraRoots/set', { extraRoots: this.skillsExtraRoots });
        this.log.info({ roots: this.skillsExtraRoots }, 'codex skill roots registered');
      } catch (err) {
        this.log.error({ err, roots: this.skillsExtraRoots }, 'skills/extraRoots/set failed');
      }
    }
  }

  private handleChildDeath(
    child: AppServerChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
    err?: Error,
  ): void {
    if (this.child !== child) return;
    this.child = null;
    const reason =
      err !== undefined
        ? `spawn failed: ${err.message}`
        : `exited (code=${String(code)} signal=${String(signal)})`;
    this.rejectAllPending(reason);
    this.abortActiveTurns(reason);
    if (this.state === 'closed') {
      this.log.info({ code, signal }, 'codex app-server terminated on close');
      return;
    }
    this.emit('exit', { code, signal });
    if (!this.everStarted) {
      // Initial start() failure: propagate via the rejected initialize.
      this.state = 'idle';
      this.log.error({ code, signal, err }, `codex app-server failed to start: ${reason}`);
      return;
    }
    this.log.warn({ code, signal, err }, `codex app-server died: ${reason}`);
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.state === 'closed' || this.restartTimer !== null) return;
    this.state = 'restarting';
    const uptimeMs = Date.now() - this.spawnedAt;
    if (uptimeMs >= this.backoff.stableMs) this.restartAttempts = 0;
    const delayMs = Math.min(
      this.backoff.initialMs * this.backoff.factor ** this.restartAttempts,
      this.backoff.maxMs,
    );
    this.restartAttempts += 1;
    this.log.warn({ delayMs, attempt: this.restartAttempts }, 'codex app-server restart scheduled');
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restart();
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private async restart(): Promise<void> {
    try {
      await this.spawnAndHandshake();
    } catch (err) {
      // Death during the handshake already scheduled the next attempt; a
      // synchronous spawn throw has not — cover it.
      this.log.error({ err }, 'codex app-server restart attempt failed');
      if (this.child === null) this.scheduleRestart();
      return;
    }
    this.log.info({ attempt: this.restartAttempts }, 'codex app-server restarted');
    this.emit('restarted');
    if (this.onRestarted !== undefined) {
      try {
        await this.onRestarted();
      } catch (err) {
        this.log.error({ err }, 'onRestarted callback failed');
      }
    }
  }

  private rejectAllPending(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(
        new AppServerConnectionError(
          `codex app-server ${reason} before responding to ${pending.method}`,
        ),
      );
    }
    this.pending.clear();
  }

  private abortActiveTurns(reason: string): void {
    for (const [threadId, turnIds] of this.activeTurns) {
      for (const turnId of turnIds) {
        this.dispatchThreadEvent({
          type: 'turnAborted',
          threadId,
          turnId,
          error: { message: `codex app-server ${reason} mid-turn`, retryable: true },
        });
      }
    }
    this.activeTurns.clear();
  }

  private trackTurn(threadId: string, turnId: string): void {
    let set = this.activeTurns.get(threadId);
    if (set === undefined) {
      set = new Set();
      this.activeTurns.set(threadId, set);
    }
    set.add(turnId);
  }

  private untrackTurn(threadId: string, turnId: string): void {
    const set = this.activeTurns.get(threadId);
    if (set === undefined) return;
    set.delete(turnId);
    if (set.size === 0) this.activeTurns.delete(threadId);
  }

  // -------------------------------------------------------------------- wire

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (child?.stdin == null) {
      return Promise.reject(
        new AppServerConnectionError(`codex app-server is not running — cannot send ${method}`),
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
    });
    this.send({ id, method, params });
    return promise;
  }

  private send(msg: WireMessage): void {
    const child = this.child;
    if (child?.stdin == null) {
      this.log.warn({ msg }, 'dropping outbound message — no child');
      return;
    }
    this.log.debug({ dir: 'out', msg }, 'jsonrpc');
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onStdout(text: string): void {
    this.stdoutBuffer += text;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      let msg: WireMessage;
      try {
        msg = JSON.parse(line) as WireMessage;
      } catch {
        this.log.warn({ line }, 'non-JSON line on app-server stdout — skipped');
        continue;
      }
      this.routeMessage(msg);
    }
  }

  private routeMessage(msg: WireMessage): void {
    this.log.debug({ dir: 'in', msg }, 'jsonrpc');
    if (typeof msg.method === 'string' && msg.id !== undefined) {
      this.handleServerRequest(msg.id, msg.method, msg.params);
    } else if (msg.id !== undefined) {
      this.handleResponse(msg);
    } else if (typeof msg.method === 'string') {
      this.handleNotification(msg.method, msg.params);
    } else {
      this.log.warn({ msg }, 'unroutable app-server message');
    }
  }

  private handleResponse(msg: WireMessage): void {
    const pending = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (pending === undefined) {
      this.log.warn({ id: msg.id }, 'response for unknown request id');
      return;
    }
    this.pending.delete(msg.id as number);
    if (msg.error !== undefined) {
      pending.reject(
        new AppServerRequestError(pending.method, msg.error.code, msg.error.message, msg.error.data),
      );
    } else {
      pending.resolve(msg.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    this.emit('notification', { method, params });

    const p = params as { threadId?: unknown; turnId?: unknown; turn?: { id?: unknown } };
    if (method === 'turn/started' || method === 'turn/completed') {
      const turn = (params as v2.TurnCompletedNotification).turn;
      const threadId = (params as v2.TurnCompletedNotification).threadId;
      if (method === 'turn/started') {
        this.trackTurn(threadId, turn.id);
        this.log.info({ threadId, turnId: turn.id }, 'turn started');
      } else {
        this.untrackTurn(threadId, turn.id);
        this.log.info(
          { threadId, turnId: turn.id, status: turn.status, durationMs: turn.durationMs, error: turn.error },
          'turn completed',
        );
      }
    }

    if (typeof p?.threadId !== 'string') return; // not thread-scoped (boot noise etc.)
    const mapped = THREAD_EVENT_TYPES[method];
    const event: ThreadEvent =
      mapped !== undefined
        ? // Payload shapes are locked to the generated notification types.
          ({ type: mapped, ...(params as Record<string, unknown>) } as ThreadEvent)
        : { type: 'raw', threadId: p.threadId, method, params };
    this.dispatchThreadEvent(event);
  }

  private dispatchThreadEvent(event: ThreadEvent): void {
    this.emit('threadEvent', event);
    const subscribers = this.threadSubscribers.get(event.threadId);
    if (subscribers === undefined) return;
    for (const listener of [...subscribers]) {
      try {
        listener(event);
      } catch (err) {
        this.log.error({ err, threadId: event.threadId, type: event.type }, 'thread listener threw');
      }
    }
  }

  /**
   * Server→client requests MUST be answered or the turn hangs
   * (PROTOCOL_NOTES §1, §8). Elicitations go through the injected approver;
   * approval requests should never occur under approvalPolicy:"never" (D9) —
   * decline them and log loudly as dead-man's insurance.
   */
  private handleServerRequest(id: number | string, method: string, params: unknown): void {
    switch (method) {
      case 'mcpServer/elicitation/request': {
        const ctx = buildElicitationContext(params as v2.McpServerElicitationRequestParams);
        let approved = false;
        try {
          approved = this.approveElicitation(ctx);
        } catch (err) {
          this.log.error({ err }, 'elicitation approver threw — declining');
        }
        const action = approved ? 'accept' : 'decline';
        if (approved) {
          this.log.debug(
            { threadId: ctx.threadId, serverName: ctx.serverName, toolName: ctx.toolName },
            'MCP elicitation auto-accepted',
          );
        } else {
          this.log.warn(
            { threadId: ctx.threadId, serverName: ctx.serverName, toolName: ctx.toolName, approvalKind: ctx.approvalKind },
            'MCP elicitation DECLINED — tool not in the allowed set',
          );
        }
        const response: v2.McpServerElicitationRequestResponse = {
          action,
          content: null,
          _meta: null,
        };
        this.send({ id, result: response });
        break;
      }
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval': {
        this.log.error(
          { method, params },
          'unexpected approval request under approvalPolicy:"never" — declining (prompt-bug)',
        );
        this.send({ id, result: { decision: 'decline' } });
        break;
      }
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        this.log.error(
          { method, params },
          'unexpected legacy approval request under approvalPolicy:"never" — denying (prompt-bug)',
        );
        this.send({ id, result: { decision: 'denied' } });
        break;
      }
      default: {
        this.log.error(
          { method, params },
          'unsupported server→client request — answering with an error so the turn cannot hang',
        );
        this.send({
          id,
          error: {
            code: -32601,
            message: `eduagent client cannot handle server request "${method}"; declined`,
          },
        });
      }
    }
    this.emit('serverRequest', { method, params });
  }
}
