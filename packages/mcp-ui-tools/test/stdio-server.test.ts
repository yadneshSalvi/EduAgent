import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end stdio smoke: spawns the REAL entry exactly the way the agent
 * host registers it with codex (node + tsx cli + src/index.ts + RELAY_PORT
 * env), speaks MCP JSON-RPC over stdio, and asserts calls are forwarded to
 * the relay as `{tool, args, sessionToken}`.
 */

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(packageDir, 'src', 'index.ts');
const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');

interface RelayCall {
  url: string;
  body: unknown;
}

let relay: Server;
let relayPort: number;
let relayCalls: RelayCall[];
let nextRelayResponse: { status: number; body: unknown };
let child: ChildProcessWithoutNullStreams;
let stdoutBuffer = '';
const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
let nextId = 1;

function request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout on ${method}`)), 15_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

beforeAll(async () => {
  relayCalls = [];
  nextRelayResponse = { status: 200, body: { ok: true, message: 'delivered' } };
  relay = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += String(chunk)));
    req.on('end', () => {
      relayCalls.push({ url: req.url ?? '', body: JSON.parse(raw) });
      res.writeHead(nextRelayResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(nextRelayResponse.body));
    });
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  relayPort = (relay.address() as { port: number }).port;

  child = spawn(process.execPath, [tsxCli, entry], {
    env: { ...process.env, RELAY_PORT: String(relayPort) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += String(chunk);
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.0.0' },
  });
  expect(init.error).toBeUndefined();
  expect(init.result).toMatchObject({ serverInfo: { name: 'eduagent-ui' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
}, 30_000);

afterAll(async () => {
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000).unref();
  });
  await new Promise<void>((resolve) => relay.close(() => resolve()));
});

describe('eduagent-ui over stdio (as codex spawns it)', () => {
  it('lists all 9 ui_* tools with schemas', async () => {
    const res = await request('tools/list', {});
    const tools = (res.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ui_create_exam',
      'ui_grade_exam',
      'ui_grade_exercise',
      'ui_grade_quiz',
      'ui_push_artifact',
      'ui_push_exercise',
      'ui_push_quiz',
      'ui_record_assessment',
      'ui_session_wrap',
    ]);
  });

  it('forwards tools/call to the relay as {tool, args, sessionToken} and relays the message', async () => {
    const args = { session_token: 'tok-123', id: 'a1', title: 'T', html: '<p>x</p>' };
    const res = await request('tools/call', { name: 'ui_push_artifact', arguments: args });
    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: 'delivered' }],
    });
    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]).toMatchObject({
      url: '/tool-call',
      body: { tool: 'ui_push_artifact', args, sessionToken: 'tok-123' },
    });
  });

  it('surfaces relay errors as isError text the model can act on', async () => {
    nextRelayResponse = {
      status: 401,
      body: { ok: false, error: 'Your session_token was not recognized. Re-read it.' },
    };
    const res = await request('tools/call', {
      name: 'ui_push_artifact',
      arguments: { session_token: 'bad', id: 'a1', title: 'T', html: '<p>x</p>' },
    });
    expect(res.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'Your session_token was not recognized. Re-read it.' }],
    });
    nextRelayResponse = { status: 200, body: { ok: true, message: 'delivered' } };
  });

  it('rejects unknown tools without hitting the relay', async () => {
    const before = relayCalls.length;
    const res = await request('tools/call', { name: 'ui_bogus', arguments: {} });
    expect(res.result).toMatchObject({ isError: true });
    expect((res.result as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      'Unknown tool',
    );
    expect(relayCalls.length).toBe(before);
  });
});
