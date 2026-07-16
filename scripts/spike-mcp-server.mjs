#!/usr/bin/env node
// Zero-dependency stdio MCP server used by scripts/spike-appserver.mjs to
// verify that codex app-server can register and call an external MCP tool.
// Implements just enough of the MCP protocol: initialize, tools/list,
// tools/call for a single tool `spike_echo`. Wire: newline-delimited
// JSON-RPC 2.0 on stdio (MCP requires the "jsonrpc":"2.0" header, unlike
// the app-server wire).

import { createInterface } from 'node:readline';

const log = (...a) => process.stderr.write(`[spike-mcp] ${a.join(' ')}\n`);

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'spike_echo',
    description: 'Echo back the provided text argument.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to echo back' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    log('unparseable line:', line.slice(0, 200));
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification — nothing to do
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'spike-mcp', version: '0.0.1' },
      });
      break;
    case 'ping':
      result(id, {});
      break;
    case 'tools/list':
      result(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const { name, arguments: args } = params ?? {};
      if (name !== 'spike_echo') {
        error(id, -32602, `unknown tool: ${name}`);
        break;
      }
      result(id, {
        content: [{ type: 'text', text: `spike_echo says: ${args?.text}` }],
        isError: false,
      });
      break;
    }
    default:
      error(id, -32601, `method not found: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
log('started');
