import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { v2 } from '@eduagent/shared/protocol';
import { UI_TOOL_NAMES } from '@eduagent/shared';
import {
  assertUiToolsVisible,
  UI_TOOLS_SERVER_NAME,
  uiToolElicitationApprover,
  uiToolsServerSpec,
} from '../src/boot.js';
import { redactForLog } from '../src/codex/AppServerClient.js';
import type { ElicitationContext } from '../src/codex/index.js';
import { loadConfig } from '../src/config.js';

/** Phase 2 carry-overs (a) and (f): the elicitation pin and log redaction. */

function ctx(overrides: Partial<ElicitationContext>): ElicitationContext {
  return {
    threadId: 't-1',
    turnId: 'turn-1',
    serverName: UI_TOOLS_SERVER_NAME,
    toolName: 'ui_push_quiz',
    approvalKind: 'mcp_tool_call',
    params: {} as v2.McpServerElicitationRequestParams,
    ...overrides,
  };
}

describe('uiToolElicitationApprover (carry-over a)', () => {
  it('accepts ui_* tool calls from the eduagent-ui server only', () => {
    expect(uiToolElicitationApprover(ctx({}))).toBe(true);
  });

  it('declines ui_* look-alikes from OTHER MCP servers (server-name pin)', () => {
    expect(uiToolElicitationApprover(ctx({ serverName: 'evil-server' }))).toBe(false);
  });

  it('declines non-ui tools, unknown tool names, and non-tool-call kinds', () => {
    expect(uiToolElicitationApprover(ctx({ toolName: 'spike_echo' }))).toBe(false);
    expect(uiToolElicitationApprover(ctx({ toolName: null }))).toBe(false);
    expect(uiToolElicitationApprover(ctx({ approvalKind: 'rules' }))).toBe(false);
    expect(uiToolElicitationApprover(ctx({ approvalKind: null }))).toBe(false);
  });
});

describe('uiToolsServerSpec', () => {
  it('spawns node + tsx cli + the mcp-ui-tools entry with RELAY_PORT env', () => {
    const config = loadConfig({});
    const spec = uiToolsServerSpec(config, 9123);
    expect(spec.command).toBe(process.execPath);
    expect(spec.args).toHaveLength(2);
    // Both the tsx CLI and the entry must exist — a broken resolution here
    // would otherwise only surface as a silent MCP startup failure in codex.
    for (const file of spec.args) expect(fs.existsSync(file), file).toBe(true);
    expect(spec.args[1]).toContain('packages/mcp-ui-tools/src/index.ts');
    expect(spec.env).toEqual({ RELAY_PORT: '9123' });
  });
});

describe('assertUiToolsVisible', () => {
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  it('requires every shared UI tool name, not merely a non-empty server', async () => {
    const status = (names: string[]) => ({
      listMcpServerStatus: () =>
        Promise.resolve({
          data: [
            {
              name: UI_TOOLS_SERVER_NAME,
              tools: Object.fromEntries(names.map((name) => [name, { name }])),
            },
          ],
        }),
    });
    await expect(assertUiToolsVisible(status(UI_TOOL_NAMES), logger)).resolves.toBeUndefined();
    await expect(assertUiToolsVisible(status(UI_TOOL_NAMES.slice(0, -1)), logger)).rejects.toThrow(
      'ui_session_wrap',
    );
  });
});

describe('redactForLog (carry-over f)', () => {
  it('redacts developerInstructions (carries the sessionToken) from params', () => {
    const msg = {
      id: 1,
      method: 'thread/start',
      params: { cwd: '/w', developerInstructions: 'session_token: SECRET' },
    };
    const redacted = redactForLog(msg);
    expect(redacted.params).toEqual({ cwd: '/w', developerInstructions: '[redacted]' });
    // The original message is untouched — redaction is log-only.
    expect((msg.params as { developerInstructions: string }).developerInstructions).toContain(
      'SECRET',
    );
  });

  it('redacts mcpToolCall item arguments (inbound item events carry session_token)', () => {
    const msg = {
      method: 'item/completed',
      params: {
        threadId: 't',
        item: {
          type: 'mcpToolCall',
          id: 'i1',
          tool: 'ui_push_artifact',
          arguments: '{"session_token":"SECRET","id":"a"}',
          status: 'completed',
        },
      },
    };
    const redacted = redactForLog(msg);
    expect((redacted.params as { item: { arguments: string } }).item.arguments).toBe('[redacted]');
    expect((redacted.params as { item: { tool: string } }).item.tool).toBe('ui_push_artifact');
    // Original untouched.
    expect((msg.params.item as { arguments: string }).arguments).toContain('SECRET');
  });

  it('redacts elicitation _meta.tool_params (repeats the tool arguments)', () => {
    const msg = {
      id: 0,
      method: 'mcpServer/elicitation/request',
      params: {
        threadId: 't',
        serverName: 'eduagent-ui',
        _meta: {
          codex_approval_kind: 'mcp_tool_call',
          tool_params: { session_token: 'SECRET' },
        },
      },
    };
    const redacted = redactForLog(msg);
    const meta = (redacted.params as { _meta: Record<string, unknown> })._meta;
    expect(meta.tool_params).toBe('[redacted]');
    expect(meta.codex_approval_kind).toBe('mcp_tool_call');
  });

  it('leaves other messages alone', () => {
    const msg = { id: 2, method: 'turn/start', params: { threadId: 't', input: [] } };
    expect(redactForLog(msg)).toBe(msg);
  });

  it('leaves non-mcpToolCall items alone', () => {
    const msg = {
      method: 'item/completed',
      params: { threadId: 't', item: { type: 'agentMessage', id: 'i1', text: 'hi' } },
    };
    expect(redactForLog(msg)).toBe(msg);
  });
});
