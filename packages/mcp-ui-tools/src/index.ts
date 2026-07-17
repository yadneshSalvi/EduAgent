/**
 * Entry point, spawned BY codex per its MCP registration (plans/01 §1):
 * the agent host registers `mcp_servers.eduagent-ui` with
 * `command=node args=[tsx-cli, this file] env={RELAY_PORT}` (env-table
 * rendering verified live — PROTOCOL_NOTES §8).
 *
 * stdout belongs to the MCP wire; anything human goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createUiToolsServer } from './server.js';

const relayPort = Number(process.env.RELAY_PORT);
if (!Number.isInteger(relayPort) || relayPort <= 0 || relayPort > 65_535) {
  process.stderr.write(
    `[eduagent-ui] RELAY_PORT env is required (got ${JSON.stringify(process.env.RELAY_PORT)})\n`,
  );
  process.exit(1);
}

const server = createUiToolsServer({ relayPort });
await server.connect(new StdioServerTransport());
process.stderr.write(`[eduagent-ui] MCP server up, relaying to 127.0.0.1:${relayPort}\n`);
