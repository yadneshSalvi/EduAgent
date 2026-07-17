import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { isUiToolName, UI_TOOL_NAMES } from '@eduagent/shared';
import { forwardToolCall } from './relay-client.js';
import { buildUiToolDefinitions } from './tool-defs.js';

/**
 * The eduagent-ui MCP stdio server (plans/01 §4.5, plans/03 §5): exposes the
 * ui_* tools to the Codex agent and forwards every call + session_token to
 * the UiToolRelay. Zero business logic — auth, validation, persistence, and
 * WS pushes all live in the relay.
 */
export interface UiToolsServerOptions {
  relayPort: number;
}

export function createUiToolsServer(opts: UiToolsServerOptions): Server {
  const server = new Server(
    { name: 'eduagent-ui', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  const definitions = buildUiToolDefinitions();
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: definitions }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!isUiToolName(name)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Unknown tool "${name}". Available EduAgent UI tools: ${UI_TOOL_NAMES.join(', ')}.`,
          },
        ],
        isError: true,
      };
    }
    const outcome = await forwardToolCall(opts.relayPort, name, args ?? {});
    return {
      content: [{ type: 'text' as const, text: outcome.text }],
      isError: !outcome.ok,
    };
  });

  return server;
}
