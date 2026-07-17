/**
 * AppServerClient against the fake child harness. Wire shapes replayed from
 * scripts/fixtures/appserver (the Phase 0 captures) — never guessed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AppServerClient,
  AppServerConnectionError,
  AppServerRequestError,
  renderMcpConfigArgs,
  type AppServerClientOptions,
  type CodexLogger,
  type ElicitationContext,
  type ThreadEvent,
} from '../src/codex/index.js';
import {
  FakeAppServer,
  fakeSpawner,
  fixtureNotifications,
  loadFixture,
  type WireMessage,
} from './helpers/fake-appserver.js';

const THREAD_ID = '019f6d0f-dd48-7002-854d-a9d4cb447c94';
const TURN_ID = '019f6d0f-dda8-7f71-a495-81db4a377229';

const MINIMAL_TURN = {
  turn: {
    id: 'turn-test-1',
    items: [],
    itemsView: 'notLoaded',
    status: 'inProgress',
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
  },
};

function collectingLogger(): { logger: CodexLogger; entries: Array<{ level: string; obj: unknown; msg?: string }> } {
  const entries: Array<{ level: string; obj: unknown; msg?: string }> = [];
  const push = (level: string) => (obj: unknown, msg?: string) => {
    entries.push({ level, obj, msg });
  };
  return {
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    entries,
  };
}

const openClients: AppServerClient[] = [];

async function startedClient(opts: Partial<AppServerClientOptions> = {}): Promise<{
  client: AppServerClient;
  fake: FakeAppServer;
  spawns: ReturnType<typeof fakeSpawner>['spawns'];
}> {
  const { spawnFn, spawns } = fakeSpawner();
  const client = new AppServerClient({
    codexBin: 'codex-fake',
    defaultModel: 'gpt-5.6-sol',
    spawnFn,
    backoff: { initialMs: 10, factor: 2, maxMs: 100, stableMs: 60_000 },
    ...opts,
  });
  openClients.push(client);
  await client.start();
  const first = spawns[0];
  if (first === undefined) throw new Error('no spawn recorded');
  return { client, fake: first.child, spawns };
}

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()));
});

describe('handshake', () => {
  it('sends initialize with clientInfo then the initialized notification', async () => {
    const { client, fake } = await startedClient();
    expect(client.isRunning).toBe(true);

    const init = fake.received[0];
    expect(init).toMatchObject({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'eduagent', title: 'EduAgent', version: '0.1.0' },
        capabilities: null,
      },
    });
    const initialized = fake.received[1];
    expect(initialized).toEqual({ method: 'initialized', params: {} });
  });

  it('rejects requests before start and after close with a retryable error', async () => {
    const { spawnFn } = fakeSpawner();
    const client = new AppServerClient({ codexBin: 'x', defaultModel: 'm', spawnFn });
    await expect(client.listModels()).rejects.toBeInstanceOf(AppServerConnectionError);
    await expect(client.listModels()).rejects.toMatchObject({ retryable: true });
    await client.close();
    await expect(client.readAccount()).rejects.toBeInstanceOf(AppServerConnectionError);
  });

  it('start() rejects when the binary cannot spawn, without auto-restart', async () => {
    const spawns: FakeAppServer[] = [];
    const client = new AppServerClient({
      codexBin: 'definitely-missing',
      defaultModel: 'm',
      backoff: { initialMs: 5, factor: 2, maxMs: 20, stableMs: 60_000 },
      spawnFn: () => {
        const fake = new FakeAppServer();
        spawns.push(fake);
        fake.failSpawn('spawn definitely-missing ENOENT');
        return fake;
      },
    });
    openClients.push(client);
    await expect(client.start()).rejects.toBeInstanceOf(AppServerConnectionError);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawns).toHaveLength(1);
    expect(client.isRunning).toBe(false);
  });
});

describe('request correlation', () => {
  it('resolves concurrent requests by id even when responses arrive out of order', async () => {
    const { client, fake } = await startedClient();
    const a = client.requestUntyped('model/list', { limit: 1 });
    const b = client.requestUntyped('skills/list', { cwds: ['/w'], forceReload: true });
    const reqA = await fake.waitFor((m) => m.method === 'model/list');
    const reqB = await fake.waitFor((m) => m.method === 'skills/list');
    fake.respond(reqB.id as number, { data: [{ cwd: '/w', skills: [] }] });
    fake.respond(reqA.id as number, { data: [], nextCursor: null });
    await expect(a).resolves.toEqual({ data: [], nextCursor: null });
    await expect(b).resolves.toEqual({ data: [{ cwd: '/w', skills: [] }] });
  });

  it('maps JSON-RPC error responses to non-retryable AppServerRequestError', async () => {
    const { client, fake } = await startedClient();
    const pending = client.listModels();
    const req = await fake.waitFor((m) => m.method === 'model/list');
    fake.respondError(req.id as number, -32600, 'Not initialized');
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppServerRequestError);
    expect(err).toMatchObject({ code: -32600, method: 'model/list', retryable: false });
  });

  it('rejects in-flight requests when the client is closed', async () => {
    const { client, fake } = await startedClient();
    fake.onMethod('account/read', () => {}); // swallow: never respond
    const pending = client.readAccount();
    const rejection = expect(pending).rejects.toBeInstanceOf(AppServerConnectionError);
    await client.close();
    await rejection;
  });
});

describe('convenience wrappers (wire params per PROTOCOL_NOTES §3)', () => {
  it('startThread pins sandbox/approval and passes developerInstructions', async () => {
    const { client, fake } = await startedClient();
    const fixture = loadFixture('03-thread-start.jsonl');
    fake.onMethod('thread/start', (msg) => fake.respond(msg.id as number, fixture[0]?.result));

    const res = await client.startThread({ cwd: '/data/workspaces/u1', developerInstructions: 'Mode: LEARN' });
    const sent = await fake.waitFor((m) => m.method === 'thread/start');
    expect(sent.params).toEqual({
      cwd: '/data/workspaces/u1',
      model: 'gpt-5.6-sol',
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      developerInstructions: 'Mode: LEARN',
    });
    expect(res.thread.id).toBeTypeOf('string');
  });

  it('startTurn ALWAYS sends the locked sandbox policy, approvalPolicy never, and defaults', async () => {
    const { client, fake } = await startedClient();
    fake.onMethod('turn/start', (msg) => fake.respond(msg.id as number, MINIMAL_TURN));

    await client.startTurn(THREAD_ID, 'hello');
    const sent = await fake.waitFor((m) => m.method === 'turn/start');
    expect(sent.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: 'text', text: 'hello', text_elements: [] }],
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
      approvalPolicy: 'never',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      summary: 'detailed',
    });
  });

  it('startTurn honors per-turn overrides without loosening the sandbox excludes', async () => {
    const { client, fake } = await startedClient({ defaultEffort: 'low', defaultSummary: 'auto' });
    fake.onMethod('turn/start', (msg) => fake.respond(msg.id as number, MINIMAL_TURN));

    await client.startTurn(THREAD_ID, 'hi', {
      model: 'gpt-5.6-terra',
      effort: 'high',
      summary: 'none',
      writableRoots: ['/extra'],
      clientUserMessageId: 'cum-1',
    });
    const sent = await fake.waitFor((m) => m.method === 'turn/start');
    expect(sent.params).toMatchObject({
      model: 'gpt-5.6-terra',
      effort: 'high',
      summary: 'none',
      clientUserMessageId: 'cum-1',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/extra'],
        networkAccess: false,
        excludeSlashTmp: true,
        excludeTmpdirEnvVar: true,
      },
      approvalPolicy: 'never',
    });
  });

  it('resumeThread/forkThread/interruptTurn/listSkills send the observed shapes', async () => {
    const { client, fake } = await startedClient();
    const threadResult = loadFixture('03-thread-start.jsonl')[0]?.result;
    fake.onMethod('thread/resume', (msg) => fake.respond(msg.id as number, threadResult));
    fake.onMethod('thread/fork', (msg) => fake.respond(msg.id as number, threadResult));
    fake.onMethod('turn/interrupt', (msg) => fake.respond(msg.id as number, {}));
    fake.onMethod('skills/list', (msg) => fake.respond(msg.id as number, { data: [] }));

    await client.resumeThread({ threadId: THREAD_ID, developerInstructions: 'Mode: REVIEW' });
    expect((await fake.waitFor((m) => m.method === 'thread/resume')).params).toEqual({
      threadId: THREAD_ID,
      developerInstructions: 'Mode: REVIEW',
    });

    await client.forkThread({ threadId: THREAD_ID, lastTurnId: TURN_ID });
    expect((await fake.waitFor((m) => m.method === 'thread/fork')).params).toEqual({
      threadId: THREAD_ID,
      lastTurnId: TURN_ID,
    });

    await client.interruptTurn(THREAD_ID, TURN_ID);
    expect((await fake.waitFor((m) => m.method === 'turn/interrupt')).params).toEqual({
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });

    await client.listSkills(['/w']);
    expect((await fake.waitFor((m) => m.method === 'skills/list')).params).toEqual({
      cwds: ['/w'],
      forceReload: true,
    });
  });
});

describe('event mapping (fixture 04 replay)', () => {
  it('maps the captured turn stream to typed thread events in order', async () => {
    const { client, fake } = await startedClient();
    const fixture = loadFixture('04-turn-ping.jsonl');
    const turnResult = fixture.find((m) => m.id !== undefined && m.method === undefined)?.result;
    const notifications = fixtureNotifications('04-turn-ping.jsonl');

    const events: ThreadEvent[] = [];
    const otherThreadEvents: ThreadEvent[] = [];
    const rawNotifications: string[] = [];
    client.on('notification', (n) => rawNotifications.push(n.method));
    client.onThreadEvent('some-other-thread', (e) => otherThreadEvents.push(e));

    const completed = new Promise<void>((resolve) => {
      const off = client.onThreadEvent(THREAD_ID, (event) => {
        events.push(event);
        if (event.type === 'turnCompleted') {
          off();
          resolve();
        }
      });
    });

    fake.onMethod('turn/start', (msg) => {
      fake.respond(msg.id as number, turnResult);
      for (const n of notifications) fake.notifyClient(n.method as string, n.params);
    });

    const res = await client.startTurn(THREAD_ID, 'ping');
    expect(res.turn.id).toBe(TURN_ID); // D11: turn id available from the response
    await completed;

    expect(events.map((e) => e.type)).toEqual([
      'raw', // mcpServer/startupStatus/updated passthrough
      'threadStatusChanged',
      'turnStarted',
      'raw',
      'itemStarted', // userMessage
      'itemCompleted',
      'itemStarted', // agentMessage
      'agentMessageDelta',
      'itemCompleted',
      'tokenUsageUpdated',
      'threadStatusChanged',
      'turnCompleted',
    ]);

    const delta = events.find((e) => e.type === 'agentMessageDelta');
    expect(delta).toMatchObject({ threadId: THREAD_ID, turnId: TURN_ID, delta: 'pong' });

    const agentDone = events.filter((e) => e.type === 'itemCompleted')[1];
    expect(agentDone).toMatchObject({
      item: { type: 'agentMessage', text: 'pong', phase: 'final_answer' },
    });

    const turnCompleted = events.find((e) => e.type === 'turnCompleted');
    expect(turnCompleted).toMatchObject({ turn: { id: TURN_ID, status: 'completed' } });

    const raw = events.find((e) => e.type === 'raw');
    expect(raw).toMatchObject({ method: 'mcpServer/startupStatus/updated', threadId: THREAD_ID });

    expect(otherThreadEvents).toEqual([]);
    expect(rawNotifications).toEqual(notifications.map((n) => n.method));
  });

  it('onThreadEvent unsubscribe stops delivery', async () => {
    const { client, fake } = await startedClient();
    const events: ThreadEvent[] = [];
    const off = client.onThreadEvent(THREAD_ID, (e) => events.push(e));
    fake.notifyClient('turn/diff/updated', { threadId: THREAD_ID, turnId: TURN_ID, diff: 'x' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(1);
    off();
    fake.notifyClient('turn/diff/updated', { threadId: THREAD_ID, turnId: TURN_ID, diff: 'y' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toHaveLength(1);
  });
});

describe('server requests (PROTOCOL_NOTES §8)', () => {
  function elicitationParams(): Record<string, unknown> {
    const fixture = loadFixture('08-mcp.jsonl').find(
      (m) => m.method === 'mcpServer/elicitation/request',
    );
    if (fixture === undefined) throw new Error('elicitation fixture line missing');
    return structuredClone(fixture.params) as Record<string, unknown>;
  }

  it('auto-accepts MCP tool-call elicitations for ui_* tools', async () => {
    const { fake } = await startedClient();
    const params = elicitationParams();
    params.message = 'Allow the eduagent-ui MCP server to run tool "ui_push_quiz"?';
    fake.serverRequest(100, 'mcpServer/elicitation/request', params);
    const response = await fake.waitFor((m) => m.id === 100 && m.method === undefined);
    expect(response.result).toEqual({ action: 'accept', content: null, _meta: null });
  });

  it('declines elicitations for tools outside the predicate (captured spike_echo)', async () => {
    const { logger, entries } = collectingLogger();
    const { fake } = await startedClient({ logger });
    fake.serverRequest(101, 'mcpServer/elicitation/request', elicitationParams());
    const response = await fake.waitFor((m) => m.id === 101 && m.method === undefined);
    expect(response.result).toEqual({ action: 'decline', content: null, _meta: null });
    const warn = entries.find((e) => e.level === 'warn' && e.msg?.includes('DECLINED'));
    expect(warn?.obj).toMatchObject({ serverName: 'spike', toolName: 'spike_echo' });
  });

  it('uses an injected approver and passes it the parsed context', async () => {
    const seen: ElicitationContext[] = [];
    const { fake } = await startedClient({
      approveElicitation: (ctx) => {
        seen.push(ctx);
        return ctx.serverName === 'spike';
      },
    });
    fake.serverRequest(102, 'mcpServer/elicitation/request', elicitationParams());
    const response = await fake.waitFor((m) => m.id === 102 && m.method === undefined);
    expect(response.result).toMatchObject({ action: 'accept' });
    expect(seen[0]).toMatchObject({
      threadId: THREAD_ID,
      serverName: 'spike',
      toolName: 'spike_echo',
      approvalKind: 'mcp_tool_call',
    });
  });

  it('declines approval requests that should never fire under approvalPolicy never', async () => {
    const { logger, entries } = collectingLogger();
    const { fake } = await startedClient({ logger });
    fake.serverRequest(103, 'item/commandExecution/requestApproval', { threadId: THREAD_ID });
    const decline = await fake.waitFor((m) => m.id === 103 && m.method === undefined);
    expect(decline.result).toEqual({ decision: 'decline' });

    fake.serverRequest(104, 'item/permissions/requestApproval', { threadId: THREAD_ID });
    const errored = await fake.waitFor((m) => m.id === 104 && m.method === undefined);
    expect(errored.error).toMatchObject({ code: -32601 });
    expect(entries.some((e) => e.level === 'error')).toBe(true);
  });
});

describe('crash, restart, backoff', () => {
  it('fails pending requests and in-flight turns with retryable errors, then restarts', async () => {
    const restartedCalls: number[] = [];
    const { client, fake, spawns } = await startedClient({
      onRestarted: () => {
        restartedCalls.push(Date.now());
      },
    });
    fake.onMethod('turn/start', (msg) => {
      fake.respond(msg.id as number, MINIMAL_TURN);
      fake.notifyClient('turn/started', {
        threadId: THREAD_ID,
        turn: { ...MINIMAL_TURN.turn },
      });
    });

    const aborted: ThreadEvent[] = [];
    client.onThreadEvent(THREAD_ID, (e) => {
      if (e.type === 'turnAborted') aborted.push(e);
    });

    await client.startTurn(THREAD_ID, 'hi');
    fake.onMethod('account/read', () => {}); // swallow: dies before responding
    const pending = client.readAccount();
    const rejection = expect(pending).rejects.toMatchObject({ retryable: true });

    const restarted = new Promise<void>((resolve) => client.once('restarted', () => resolve()));
    fake.exitNow(1);
    await rejection;
    await restarted;

    expect(aborted).toHaveLength(1);
    expect(aborted[0]).toMatchObject({
      turnId: MINIMAL_TURN.turn.id,
      error: { retryable: true },
    });
    expect(restartedCalls).toHaveLength(1);
    expect(spawns).toHaveLength(2);
    expect(client.isRunning).toBe(true);

    // The new child got a fresh handshake.
    const secondSpawn = spawns[1];
    const init = await secondSpawn?.child.waitFor((m) => m.method === 'initialize');
    expect(init).toBeDefined();
  });

  it('backs off exponentially across consecutive crashes', async () => {
    const { logger, entries } = collectingLogger();
    const { client, spawns } = await startedClient({
      logger,
      backoff: { initialMs: 10, factor: 4, maxMs: 1000, stableMs: 60_000 },
    });

    const restartedOnce = new Promise<void>((resolve) => client.once('restarted', () => resolve()));
    spawns[0]?.child.exitNow(1);
    await restartedOnce;

    const restartedTwice = new Promise<void>((resolve) =>
      client.once('restarted', () => resolve()),
    );
    spawns[1]?.child.exitNow(1);
    await restartedTwice;

    const delays = entries
      .filter((e) => e.msg === 'codex app-server restart scheduled')
      .map((e) => (e.obj as { delayMs: number }).delayMs);
    expect(delays).toEqual([10, 40]);
    expect(spawns).toHaveLength(3);
  });

  it('does not restart after close()', async () => {
    const { client, spawns } = await startedClient();
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(spawns).toHaveLength(1);
    expect(client.isRunning).toBe(false);
  });
});

describe('healthProbe', () => {
  it('reports not running before start', async () => {
    const { spawnFn } = fakeSpawner();
    const client = new AppServerClient({ codexBin: 'x', defaultModel: 'm', spawnFn });
    expect(await client.healthProbe()).toMatchObject({
      ok: false,
      running: false,
      authenticated: false,
    });
    await client.close();
  });

  it('reports ok when account/read shows an account (real API-key-auth shape)', async () => {
    const { client, fake } = await startedClient();
    // Exact shape observed against the real binary under API-key auth:
    // requiresOpenaiAuth stays true even when authenticated.
    fake.onMethod('account/read', (msg) =>
      fake.respond(msg.id as number, { account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
    );
    expect(await client.healthProbe()).toEqual({
      ok: true,
      running: true,
      authenticated: true,
      authMode: 'apiKey',
    });
  });

  it('reports unauthenticated for the env-only-auth failure mode (PROTOCOL_NOTES §10)', async () => {
    const { client, fake } = await startedClient();
    fake.onMethod('account/read', (msg) =>
      fake.respond(msg.id as number, { account: null, requiresOpenaiAuth: true }),
    );
    const probe = await client.healthProbe();
    expect(probe).toMatchObject({ ok: false, running: true, authenticated: false, authMode: null });
    expect(probe.detail).toContain('not authenticated');
  });
});

describe('MCP registration args (PROTOCOL_NOTES §8)', () => {
  it('renders -c overrides exactly as spike-verified', () => {
    expect(
      renderMcpConfigArgs({
        'ui-tools': { command: 'node', args: ['/abs/path/server.mjs'] },
      }),
    ).toEqual([
      '-c',
      'mcp_servers.ui-tools.command="node"',
      '-c',
      'mcp_servers.ui-tools.args=["/abs/path/server.mjs"]',
    ]);
  });

  it('renders env as a TOML inline table and omits absent fields', () => {
    expect(renderMcpConfigArgs({ ui: { command: 'node', env: { RELAY_PORT: '8788' } } })).toEqual([
      '-c',
      'mcp_servers.ui.command="node"',
      '-c',
      'mcp_servers.ui.env={RELAY_PORT = "8788"}',
    ]);
    expect(renderMcpConfigArgs({})).toEqual([]);
    expect(renderMcpConfigArgs()).toEqual([]);
  });

  it('rejects names/env keys that are not TOML bare keys', () => {
    expect(() => renderMcpConfigArgs({ 'bad name': { command: 'x' } })).toThrow(/invalid MCP server name/);
    expect(() =>
      renderMcpConfigArgs({ ok: { command: 'x', env: { 'BAD KEY': 'v' } } }),
    ).toThrow(/invalid MCP env key/);
  });

  it('passes the rendered overrides to spawn', async () => {
    const { spawns } = await startedClient({
      mcpServers: { 'eduagent-ui': { command: 'node', args: ['/srv/ui.mjs'] } },
    });
    expect(spawns[0]?.bin).toBe('codex-fake');
    expect(spawns[0]?.args).toEqual([
      'app-server',
      '-c',
      'mcp_servers.eduagent-ui.command="node"',
      '-c',
      'mcp_servers.eduagent-ui.args=["/srv/ui.mjs"]',
    ]);
  });
});

// Sanity: fixtures used above still have the shapes this suite assumes.
describe('fixture preconditions', () => {
  it('fixture 04 contains the ping turn capture', () => {
    const notifications: WireMessage[] = fixtureNotifications('04-turn-ping.jsonl');
    expect(notifications.map((n) => n.method)).toContain('item/agentMessage/delta');
    expect(notifications.at(-1)?.method).toBe('turn/completed');
  });
});
