#!/usr/bin/env node
// Phase 0 protocol spike for `codex app-server` (EduAgent).
//
// Zero-dependency (node:child_process + node:readline only). Speaks
// newline-delimited JSON-RPC over stdio to a spawned `codex app-server`
// and walks the full checklist from plans/06_implementation_phases.md
// Phase 0 task 5. Every raw inbound message is appended to
// scripts/fixtures/appserver/<step>.jsonl (scrubbed of the API key).
//
// Isolation: everything runs under an isolated CODEX_HOME in
// data/spike-workspace/ — the user's real ~/.codex config/login is never
// read or written. Auth comes from OPENAI_API_KEY in the repo .env via
// `codex login --with-api-key` (the key value is never printed).
//
// Usage: node scripts/spike-appserver.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- paths
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(REPO, 'scripts', 'fixtures', 'appserver');
const SPIKE_ROOT = join(REPO, 'data', 'spike-workspace');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_DIR = join(SPIKE_ROOT, `run-${RUN_ID}`);
const WS = join(RUN_DIR, 'ws'); // thread cwd (the "workspace")
const LOGS = join(RUN_DIR, 'logs');
const HOME_MAIN = join(SPIKE_ROOT, 'codex-home'); // isolated CODEX_HOME (login --with-api-key)
const HOME_ENVONLY = join(SPIKE_ROOT, 'codex-home-envonly'); // isolated, env-var auth only
const MCP_SERVER = join(REPO, 'scripts', 'spike-mcp-server.mjs');
const ESCAPE_TARGET = '/tmp/spike-escape.txt';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// ------------------------------------------------------------- secrets
function loadApiKey() {
  const envFile = join(REPO, '.env');
  if (!existsSync(envFile)) throw new Error('repo .env not found');
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*("?)(.*)\1\s*$/);
    if (m && m[2]) return m[2].trim();
  }
  throw new Error('OPENAI_API_KEY not found in .env');
}
const API_KEY = loadApiKey();

function scrub(s) {
  return (
    String(s)
      .split(API_KEY)
      .join('[REDACTED_API_KEY]')
      .replace(/sk-[A-Za-z0-9][A-Za-z0-9_-]{10,}/g, 'sk-[REDACTED]')
      // codex's own masked display (e.g. "sk-abcde***wxyz") still fingerprints the key
      .replace(/sk-[A-Za-z0-9_-]*\*+[A-Za-z0-9_-]*/g, 'sk-[REDACTED]')
  );
}

// child env: never leak the key into the main spawns (auth.json must be
// sufficient); never inherit the user's CODEX_HOME if their shell sets one.
function baseEnv() {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.CODEX_HOME;
  return env;
}

// ------------------------------------------------------------- fixtures
let currentFixture = null;
function setFixture(step) {
  currentFixture = join(FIXTURES, `${step}.jsonl`);
  writeFileSync(currentFixture, ''); // truncate per run
}
function recordInbound(line) {
  if (currentFixture) appendFileSync(currentFixture, scrub(line) + '\n');
}

// ------------------------------------------------------------ reporting
const results = []; // {step, ok, note}
const obs = {
  cliVersion: null,
  initialize: null,
  models: null,
  modelId: null,
  notificationMethods: new Set(),
  serverRequests: [],
  tokenUsage: null,
  mcpMechanism: null,
  skills: {},
  authFindings: {},
  errorsSeen: [],
};
function pass(step, note = '') {
  results.push({ step, ok: true, note });
  console.log(`[PASS] ${step}${note ? ' — ' + note : ''}`);
}
function fail(step, note = '') {
  results.push({ step, ok: false, note });
  console.log(`[FAIL] ${step}${note ? ' — ' + note : ''}`);
}

// ------------------------------------------------------------ AppServer
let SPAWNED = []; // track pids for cleanup

class AppServer {
  constructor(label, { home, extraArgs = [], env = {} } = {}) {
    this.label = label;
    this.notifications = []; // {method, params}
    this.waiters = [];
    this.pending = new Map();
    this.nextId = 1;
    this.exited = false;
    const args = ['app-server', ...extraArgs];
    this.child = spawn(CODEX_BIN, args, {
      cwd: REPO,
      env: { ...baseEnv(), CODEX_HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    SPAWNED.push(this.child);
    this.stderrLog = join(LOGS, `appserver-${label}.stderr.log`);
    writeFileSync(this.stderrLog, '');
    this.child.stderr.on('data', (d) => appendFileSync(this.stderrLog, scrub(d)));
    this.child.on('exit', (code, sig) => {
      this.exited = true;
      for (const [, p] of this.pending)
        p.reject(new Error(`app-server(${label}) exited (${code ?? sig})`));
      this.pending.clear();
    });
    const rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => this.onLine(line));
  }

  onLine(line) {
    if (!line.trim()) return;
    recordInbound(line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method !== undefined && msg.id !== undefined) {
      this.onServerRequest(msg);
    } else if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(
          Object.assign(new Error(`rpc error ${msg.error.code}: ${msg.error.message}`), {
            rpc: msg.error,
          }),
        );
      else p.resolve(msg.result);
    } else if (msg.method) {
      obs.notificationMethods.add(msg.method);
      const n = { method: msg.method, params: msg.params };
      this.notifications.push(n);
      this.waiters = this.waiters.filter((w) => {
        if (!w.pred(n)) return true;
        clearTimeout(w.timer);
        w.resolve({ msg: n, index: this.notifications.length - 1 });
        return false;
      });
    }
  }

  // approvalPolicy "never" does NOT cover MCP tool-call elicitations (observed):
  // those arrive as mcpServer/elicitation/request with
  // _meta.codex_approval_kind === "mcp_tool_call" and must be answered by the
  // client. Accept those (that is exactly what the agent host will do for its
  // own ui-tools server); decline everything else loudly.
  onServerRequest(msg) {
    if (
      msg.method === 'mcpServer/elicitation/request' &&
      msg.params?._meta?.codex_approval_kind === 'mcp_tool_call'
    ) {
      console.log(`  ~ auto-accepting MCP tool-call elicitation (server=${msg.params.serverName})`);
      obs.serverRequests.push({
        method: msg.method,
        params: msg.params,
        respondedWith: { action: 'accept' },
      });
      this.write({ id: msg.id, result: { action: 'accept' } });
      return;
    }
    console.log(
      `  !! server request received (unexpected under approvalPolicy=never): ${msg.method}`,
    );
    obs.serverRequests.push({ method: msg.method, params: msg.params, respondedWith: 'decline' });
    let response;
    if (/elicitation/i.test(msg.method)) response = { action: 'decline' };
    else if (/requestApproval/i.test(msg.method)) response = { decision: 'decline' };
    else if (/execCommandApproval|applyPatchApproval/.test(msg.method))
      response = { decision: 'denied' };
    if (response) this.write({ id: msg.id, result: response });
    else this.write({ id: msg.id, error: { code: -32601, message: 'spike client declines' } });
  }

  write(obj) {
    // NOTE: no "jsonrpc" header on this wire (verified empirically).
    this.child.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params, { timeoutMs = 60_000 } = {}) {
    const id = this.nextId++;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`timeout waiting for response to ${method} (#${id})`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          res(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
      this.write({ id, method, params });
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  cursor() {
    return this.notifications.length;
  }

  waitFor(pred, { timeoutMs = 60_000, from = 0 } = {}) {
    for (let i = from; i < this.notifications.length; i++) {
      if (pred(this.notifications[i]))
        return Promise.resolve({ msg: this.notifications[i], index: i });
    }
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== res);
        rej(new Error(`timeout waiting for notification (${timeoutMs}ms)`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: res, timer });
    });
  }

  slice(from, to) {
    return this.notifications.slice(from, to);
  }

  async close() {
    if (this.exited) return;
    this.child.kill('SIGTERM');
    await new Promise((res) => {
      const t = setTimeout(() => {
        this.child.kill('SIGKILL');
        res();
      }, 3000);
      this.child.on('exit', () => {
        clearTimeout(t);
        res();
      });
    });
  }

  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'eduagent-spike', title: 'EduAgent Protocol Spike', version: '0.0.1' },
    });
    this.notify('initialized', {});
    return result;
  }
}

// MCP registration via CLI config overrides at spawn (mechanism under test).
const MCP_ARGS = [
  '-c',
  `mcp_servers.spike.command="node"`,
  '-c',
  `mcp_servers.spike.args=["${MCP_SERVER}"]`,
  // probe: does a config-level trust flag suppress the per-call elicitation?
  '-c',
  `mcp_servers.spike.trusted=true`,
];
// Belt and suspenders: also pin sandbox defaults at spawn (turn-level
// sandboxPolicy below is the authoritative, structured version).
const SANDBOX_ARGS = [
  '-c',
  `sandbox_mode="workspace-write"`,
  '-c',
  `sandbox_workspace_write.network_access=false`,
];
const SPAWN_ARGS = [...MCP_ARGS, ...SANDBOX_ARGS];

const SANDBOX_POLICY = {
  type: 'workspaceWrite',
  networkAccess: false,
  excludeSlashTmp: true, // /tmp is writable by default in workspaceWrite — exclude it so the escape test is meaningful
  excludeTmpdirEnvVar: true,
  writableRoots: [],
};

// ------------------------------------------------------------ turn helper
async function runTurn(
  server,
  threadId,
  text,
  { timeoutMs = 300_000, firstTurnOfThread = false } = {},
) {
  const from = server.cursor();
  const params = { threadId, input: [{ type: 'text', text }] };
  if (firstTurnOfThread) params.sandboxPolicy = SANDBOX_POLICY;
  const respP = server.request('turn/start', params, { timeoutMs });
  respP.catch(() => {});
  const started = await server.waitFor(
    (n) => n.method === 'turn/started' && n.params?.threadId === threadId,
    { from, timeoutMs: 90_000 },
  );
  const turnId = started.msg.params.turn.id;
  const done = await server.waitFor(
    (n) =>
      n.method === 'turn/completed' &&
      n.params?.threadId === threadId &&
      n.params?.turn?.id === turnId,
    { from, timeoutMs },
  );
  const events = server.slice(from, done.index + 1);
  const completedItems = events
    .filter((n) => n.method === 'item/completed')
    .map((n) => n.params.item);
  const agentMessages = completedItems.filter((i) => i?.type === 'agentMessage');
  const finalText = agentMessages.map((i) => i.text ?? '').join('\n');
  const usage = [...events].reverse().find((n) => n.method === 'thread/tokenUsage/updated');
  if (usage) obs.tokenUsage = usage.params;
  return {
    turnId,
    status: done.msg.params.turn.status,
    error: done.msg.params.turn.error ?? null,
    finalText,
    completedItems,
    methods: [...new Set(events.map((n) => n.method))],
    events,
  };
}

// ------------------------------------------------------------ step runner
async function step(name, fn) {
  setFixture(name);
  try {
    await fn();
  } catch (e) {
    obs.errorsSeen.push({ step: name, error: scrub(e.message) });
    fail(name, scrub(e.message));
  }
}

// ---------------------------------------------------------------- main
async function main() {
  console.log(`spike run ${RUN_ID} — workspace ${WS}`);
  for (const d of [FIXTURES, WS, LOGS, HOME_MAIN]) mkdirSync(d, { recursive: true });
  rmSync(HOME_ENVONLY, { recursive: true, force: true });
  mkdirSync(HOME_ENVONLY, { recursive: true });
  rmSync(ESCAPE_TARGET, { force: true });

  const ver = spawnSync(CODEX_BIN, ['--version'], { encoding: 'utf8' });
  obs.cliVersion = ver.stdout.trim();
  console.log(`codex: ${obs.cliVersion}`);

  // ---- 00: headless auth setup in the ISOLATED home (login --with-api-key)
  await step('00-auth-setup', async () => {
    const login = spawnSync(CODEX_BIN, ['login', '--with-api-key'], {
      input: API_KEY,
      encoding: 'utf8',
      env: { ...baseEnv(), CODEX_HOME: HOME_MAIN },
    });
    recordInbound(
      JSON.stringify({
        event: 'login --with-api-key',
        exitCode: login.status,
        stdout: scrub(login.stdout).trim(),
        stderr: scrub(login.stderr).trim(),
      }),
    );
    if (login.status !== 0)
      throw new Error(`codex login --with-api-key failed: ${scrub(login.stderr)}`);
    const status = spawnSync(CODEX_BIN, ['login', 'status'], {
      encoding: 'utf8',
      env: { ...baseEnv(), CODEX_HOME: HOME_MAIN },
    });
    recordInbound(
      JSON.stringify({
        event: 'login status',
        exitCode: status.status,
        stdout: scrub(status.stdout).trim(),
        stderr: scrub(status.stderr).trim(),
      }),
    );
    const authJson = join(HOME_MAIN, 'auth.json');
    obs.authFindings.loginWithApiKey = {
      works: login.status === 0,
      authJsonCreated: existsSync(authJson),
      authJsonKeys: existsSync(authJson)
        ? Object.keys(JSON.parse(readFileSync(authJson, 'utf8')))
        : [],
      statusOutput: scrub(status.stdout + status.stderr).trim(),
    };
    pass(
      '00-auth-setup',
      `auth.json keys: ${obs.authFindings.loginWithApiKey.authJsonKeys.join(',')}`,
    );
  });

  // ---- 01: spawn + initialize handshake
  let server = new AppServer('main-1', { home: HOME_MAIN, extraArgs: SPAWN_ARGS });
  await step('01-initialize', async () => {
    // request before initialize — record the rejection shape
    let preInitError = null;
    try {
      await server.request('model/list', {}, { timeoutMs: 15_000 });
    } catch (e) {
      preInitError = e.rpc ?? e.message;
    }
    obs.preInitError = preInitError;
    const result = await server.initialize();
    obs.initialize = result;
    if (!result?.userAgent) throw new Error('initialize returned no userAgent');
    pass(
      '01-initialize',
      `userAgent=${result.userAgent}; codexHome=${result.codexHome}; pre-init call ${preInitError ? 'rejected (good)' : 'was NOT rejected'}`,
    );
  });

  // ---- 02: model/list → GPT-5.6 id
  let MODEL = null;
  await step('02-model-list', async () => {
    const res = await server.request('model/list', { limit: 100 });
    obs.models = res.data.map((m) => ({
      id: m.id,
      model: m.model,
      displayName: m.displayName,
      isDefault: m.isDefault,
      hidden: m.hidden,
      defaultReasoningEffort: m.defaultReasoningEffort,
      supportedReasoningEfforts: m.supportedReasoningEfforts,
    }));
    const ids = obs.models.map((m) => m.id);
    MODEL =
      obs.models.find((m) => m.id === 'gpt-5.6') ??
      obs.models.find((m) => /^gpt-5\.6/.test(m.id)) ??
      obs.models.find((m) => /5\.6/.test(m.id));
    if (!MODEL) throw new Error(`no GPT-5.6 model found; ids=${ids.join(', ')}`);
    obs.modelId = MODEL.id;
    pass(
      '02-model-list',
      `GPT-5.6 id="${MODEL.id}" (model="${MODEL.model}", efforts=${JSON.stringify(MODEL.supportedReasoningEfforts)}); all ids: ${ids.join(', ')}`,
    );
  });
  if (!MODEL) throw new Error('cannot continue without a model id');

  // ---- 03: thread/start with cwd + sandbox + approvals + model
  let THREAD = null;
  await step('03-thread-start', async () => {
    const res = await server.request('thread/start', {
      cwd: WS,
      model: MODEL.id,
      sandbox: 'workspace-write',
      approvalPolicy: 'never',
      developerInstructions:
        "You are a test agent for a protocol spike. Rule: whenever a user message is exactly 'ping', reply with exactly 'pong' and nothing else. For every other message, do what it asks, using your tools when needed. Keep every reply under 30 words.",
    });
    THREAD = res.thread.id;
    if (!THREAD) throw new Error('no thread id in response');
    pass(
      '03-thread-start',
      `threadId=${THREAD}; effective model=${res.model}; sandbox=${JSON.stringify(res.sandbox)}; approvalPolicy=${JSON.stringify(res.approvalPolicy)}`,
    );
  });

  // ---- 04: cheap turn — ping → pong; capture event stream shape
  await step('04-turn-ping', async () => {
    const t = await runTurn(server, THREAD, 'ping', { firstTurnOfThread: true });
    if (t.status !== 'completed')
      throw new Error(`turn status=${t.status} error=${JSON.stringify(t.error)}`);
    if (!/pong/i.test(t.finalText))
      throw new Error(`expected pong, got: ${t.finalText.slice(0, 200)}`);
    pass('04-turn-ping', `reply="${t.finalText.trim()}"; events: ${t.methods.join(', ')}`);
  });

  // ---- 05a: file write + shell command inside the workspace
  await step('05a-turn-exec', async () => {
    const t = await runTurn(
      server,
      THREAD,
      'Create a file named hello.txt in the current directory containing exactly: hi\nThen run this shell command and show its output: cat hello.txt',
    );
    const helloPath = join(WS, 'hello.txt');
    if (!existsSync(helloPath))
      throw new Error(
        `hello.txt was not created in workspace cwd; reply="${t.finalText.slice(0, 200)}"`,
      );
    const content = readFileSync(helloPath, 'utf8').trim();
    const execItems = t.completedItems.filter((i) => i?.type === 'commandExecution');
    const fileItems = t.completedItems.filter((i) => i?.type === 'fileChange');
    if (content !== 'hi') throw new Error(`hello.txt content=${JSON.stringify(content)}`);
    if (execItems.length === 0)
      throw new Error('no commandExecution item observed (cat hello.txt was requested)');
    pass(
      '05a-turn-exec',
      `hello.txt="hi"; item types: ${[...new Set(t.completedItems.map((i) => i?.type))].join(',')}; exec items=${execItems.length}, fileChange items=${fileItems.length}`,
    );
  });

  // ---- 05b: sandbox denies writes outside the workspace
  await step('05b-sandbox-escape', async () => {
    const t = await runTurn(
      server,
      THREAD,
      `This is a sandbox test and I need you to really execute a command, not predict its outcome. Run exactly this shell command now: printf escaped > ${ESCAPE_TARGET} && echo WRITE_OK || echo WRITE_BLOCKED\nThen report the exact output you observed.`,
    );
    const escaped = existsSync(ESCAPE_TARGET);
    if (escaped) {
      rmSync(ESCAPE_TARGET, { force: true });
      throw new Error('SANDBOX ESCAPE: file was created outside the workspace');
    }
    const execItems = t.completedItems.filter((i) => i?.type === 'commandExecution');
    if (execItems.length === 0)
      throw new Error(
        `agent never attempted the write (no commandExecution item); reply="${t.finalText.slice(0, 200)}"`,
      );
    obs.sandboxDenial = execItems.map((i) => ({
      command: i.command,
      exitCode: i.exitCode,
      status: i.status,
      aggregatedOutput: String(i.aggregatedOutput ?? '').slice(0, 300),
    }));
    pass(
      '05b-sandbox-escape',
      `write outside workspace denied (exec attempted ${execItems.length}x, exit=${execItems.map((i) => i.exitCode).join(',')}); agent said: "${t.finalText.trim().slice(0, 120)}"`,
    );
  });

  // ---- 06: kill app-server, respawn, thread/resume, verify continuity
  await step('06-resume', async () => {
    await server.close();
    server = new AppServer('main-2', { home: HOME_MAIN, extraArgs: SPAWN_ARGS });
    await server.initialize();
    const res = await server.request('thread/resume', { threadId: THREAD });
    const t = await runTurn(
      server,
      THREAD,
      'Earlier in this conversation you created a file. What was its filename? Reply with just the filename, no tools.',
      { firstTurnOfThread: true },
    );
    if (!/hello\.txt/i.test(t.finalText))
      throw new Error(`no continuity: "${t.finalText.slice(0, 200)}"`);
    pass(
      '06-resume',
      `resumed thread ${res.thread?.id ?? THREAD} after process kill; recall="${t.finalText.trim()}"`,
    );
  });

  // ---- 07: thread/fork — fork sees prior context
  await step('07-fork', async () => {
    const res = await server.request('thread/fork', { threadId: THREAD });
    const forkId = res.thread.id;
    if (!forkId || forkId === THREAD) throw new Error(`bad fork id: ${forkId}`);
    const t = await runTurn(
      server,
      forkId,
      'Earlier in this conversation you created a file. What was its exact text content? Reply with just that word, no tools.',
      { firstTurnOfThread: true },
    );
    if (!/\bhi\b/i.test(t.finalText))
      throw new Error(`fork lost context: "${t.finalText.slice(0, 200)}"`);
    pass('07-fork', `forkId=${forkId}; fork recalls="${t.finalText.trim()}"`);
  });

  // ---- 08: MCP round-trip via spike_echo
  await step('08-mcp', async () => {
    let status = null;
    try {
      status = await server.request('mcpServerStatus/list', {}, { timeoutMs: 30_000 });
    } catch (e) {
      obs.errorsSeen.push({ step: '08-mcp/statusList', error: scrub(e.message) });
    }
    const names = (status?.data ?? status?.servers ?? []).map(
      (s) => s.name ?? s.id ?? JSON.stringify(s).slice(0, 40),
    );
    obs.mcpStatus = status;
    const elicitationsBefore = obs.serverRequests.filter(
      (r) => r.method === 'mcpServer/elicitation/request',
    ).length;
    const t = await runTurn(
      server,
      THREAD,
      'Call the MCP tool spike_echo with text "hello" and reply with the tool\'s output verbatim.',
    );
    const elicited =
      obs.serverRequests.filter((r) => r.method === 'mcpServer/elicitation/request').length >
      elicitationsBefore;
    const mcpItems = t.completedItems.filter((i) => i?.type === 'mcpToolCall');
    const sawEcho =
      /spike_echo says: hello/.test(JSON.stringify(mcpItems)) ||
      /spike_echo says: hello/.test(t.finalText);
    if (mcpItems.length === 0)
      throw new Error(
        `no mcpToolCall item observed; servers=[${names.join(',')}]; reply="${t.finalText.slice(0, 200)}"`,
      );
    if (!sawEcho)
      throw new Error(`tool called but echo not observed; reply="${t.finalText.slice(0, 200)}"`);
    obs.mcpMechanism = `\`-c mcp_servers.<name>.command/args=…\` CLI overrides on the app-server command line; per-call approval: ${elicited ? 'client must accept mcpServer/elicitation/request (trusted=true config flag did NOT suppress it)' : 'none after -c mcp_servers.<name>.trusted=true (elicitation suppressed)'}`;
    pass(
      '08-mcp',
      `servers=[${names.join(',')}]; mcpToolCall items=${mcpItems.length}; round-trip ok; elicitation fired=${elicited}`,
    );
  });

  // ---- 09: skills/list + install location probe (no turns)
  await step('09-skills', async () => {
    const empty = await server.request('skills/list', { cwds: [WS], forceReload: true });
    obs.skills.emptyListing = empty;
    const skillMd = [
      '---',
      'name: spike-skill',
      'description: Spike test skill; replies SKILLED.',
      '---',
      '',
      '# Spike skill',
      '',
      'When invoked, reply with the word SKILLED.',
      '',
    ].join('\n');
    const candidates = [
      { label: '<cwd>/.codex/skills', dir: join(WS, '.codex', 'skills', 'spike-skill') },
      { label: '<cwd>/.agents/skills', dir: join(WS, '.agents', 'skills', 'spike-skill') },
      { label: '$CODEX_HOME/skills', dir: join(HOME_MAIN, 'skills', 'spike-skill') },
    ];
    const found = [];
    for (const c of candidates) {
      mkdirSync(c.dir, { recursive: true });
      writeFileSync(join(c.dir, 'SKILL.md'), skillMd);
      const res = await server.request('skills/list', { cwds: [WS], forceReload: true });
      const hit = JSON.stringify(res).includes('spike-skill');
      found.push({ location: c.label, listed: hit });
      obs.skills[`after ${c.label}`] = res;
      rmSync(dirname(c.dir), { recursive: true, force: true });
      if (hit) break; // first working location is enough; keep probes cheap
    }
    obs.skills.locations = found;
    const winner = found.find((f) => f.listed);
    if (!winner) {
      pass(
        '09-skills',
        `skills/list works (shape captured) but no probed install location listed: ${JSON.stringify(found)} — installation needs Phase 1 verification`,
      );
    } else {
      pass('09-skills', `skills/list works; skill discovered at ${winner.location}`);
    }
  });

  // ---- 10: interrupt a slow turn mid-stream
  await step('10-interrupt', async () => {
    const from = server.cursor();
    // effort+summary bumped for this one turn: does GPT-5.6 emit
    // item/reasoning/summaryTextDelta or item/reasoning/textDelta? (plans/01 §4.3)
    const respP = server.request(
      'turn/start',
      {
        threadId: THREAD,
        input: [
          {
            type: 'text',
            text: 'First think briefly about why counting is fun, then count from 1 to 50 slowly, one number per line. Do not use tools.',
          },
        ],
        effort: 'medium',
        summary: 'detailed',
      },
      { timeoutMs: 300_000 },
    );
    respP.catch(() => {});
    const started = await server.waitFor(
      (n) => n.method === 'turn/started' && n.params?.threadId === THREAD,
      { from, timeoutMs: 90_000 },
    );
    const turnId = started.msg.params.turn.id;
    // interrupt as soon as tokens are streaming
    const race = await Promise.race([
      server
        .waitFor((n) => n.method === 'item/agentMessage/delta' && n.params?.turnId === turnId, {
          from,
          timeoutMs: 120_000,
        })
        .then(() => 'delta'),
      server
        .waitFor((n) => n.method === 'turn/completed' && n.params?.turn?.id === turnId, {
          from,
          timeoutMs: 120_000,
        })
        .then(() => 'completed'),
    ]);
    if (race === 'completed') throw new Error('turn completed before we could interrupt');
    const intr = await server.request(
      'turn/interrupt',
      { threadId: THREAD, turnId },
      { timeoutMs: 30_000 },
    );
    const done = await server.waitFor(
      (n) => n.method === 'turn/completed' && n.params?.turn?.id === turnId,
      { from, timeoutMs: 60_000 },
    );
    const status = done.msg.params.turn.status;
    if (status !== 'interrupted') throw new Error(`expected status interrupted, got ${status}`);
    const reasoningMethods = [
      ...new Set(
        server
          .slice(from, done.index + 1)
          .filter((n) => n.method.startsWith('item/reasoning/'))
          .map((n) => n.method),
      ),
    ];
    obs.reasoningEventMethods = reasoningMethods;
    pass(
      '10-interrupt',
      `turn/interrupt result=${JSON.stringify(intr)}; final turn status="${status}"; reasoning events at effort=medium/summary=detailed: ${reasoningMethods.join(', ') || '(none)'}`,
    );
  });

  // ---- 11: headless auth — pure env-var pickup, in a second isolated home
  await step('11-headless-env-auth', async () => {
    const envServer = new AppServer('envonly', {
      home: HOME_ENVONLY,
      extraArgs: SANDBOX_ARGS,
      env: { OPENAI_API_KEY: API_KEY },
    });
    try {
      await envServer.initialize();
      let account = null;
      try {
        account = await envServer.request('account/read', {}, { timeoutMs: 20_000 });
      } catch (e) {
        account = { error: scrub(e.message) };
      }
      obs.authFindings.envOnlyAccountRead = account;
      let turnOk = false,
        detail = '';
      try {
        const res = await envServer.request('thread/start', {
          cwd: WS,
          model: MODEL.id,
          sandbox: 'workspace-write',
          approvalPolicy: 'never',
        });
        const t = await runTurn(envServer, res.thread.id, 'Reply with exactly: ok', {
          timeoutMs: 180_000,
          firstTurnOfThread: true,
        });
        turnOk = t.status === 'completed' && /\bok\b/i.test(t.finalText);
        detail = `status=${t.status}, reply="${t.finalText.trim().slice(0, 60)}"`;
      } catch (e) {
        detail = scrub(e.message);
      }
      obs.authFindings.envOnlyTurn = { works: turnOk, detail };
      if (turnOk) {
        pass(
          '11-headless-env-auth',
          `OPENAI_API_KEY env var alone works (no login step needed); account/read=${JSON.stringify(account).slice(0, 120)}`,
        );
      } else if (obs.authFindings.loginWithApiKey?.works) {
        pass(
          '11-headless-env-auth',
          `env var alone does NOT auth (${detail}); verified mechanism: pipe key to \`codex login --with-api-key\` under target CODEX_HOME (used for this entire spike run)`,
        );
      } else {
        throw new Error(`no working headless auth mechanism found (${detail})`);
      }
    } finally {
      await envServer.close();
    }
  });

  // ---- 12: teardown + no stray processes
  await step('12-teardown', async () => {
    await server.close();
    await new Promise((r) => setTimeout(r, 500));
    const stray = SPAWNED.filter((c) => {
      try {
        process.kill(c.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    for (const c of stray) c.kill('SIGKILL');
    if (existsSync(ESCAPE_TARGET)) rmSync(ESCAPE_TARGET, { force: true });
    pass(
      '12-teardown',
      stray.length
        ? `killed ${stray.length} stragglers with SIGKILL`
        : 'all spawned codex processes exited cleanly',
    );
  });

  // ---- summary + observations dump
  setFixture('_observations');
  writeFileSync(
    join(FIXTURES, '_observations.json'),
    scrub(
      JSON.stringify({ ...obs, notificationMethods: [...obs.notificationMethods].sort() }, null, 2),
    ),
  );
  console.log('\n===== SPIKE SUMMARY =====');
  for (const r of results)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}${r.note ? ' — ' + r.note : ''}`);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  process.exitCode = failed.length ? 1 : 0;
}

process.on('exit', () => {
  for (const c of SPAWNED) {
    try {
      process.kill(c.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
});

main().catch((e) => {
  console.error('spike aborted:', scrub(e.stack ?? e.message));
  process.exitCode = 1;
});
