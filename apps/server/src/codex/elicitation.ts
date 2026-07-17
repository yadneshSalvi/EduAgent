/**
 * MCP elicitation handling (PROTOCOL_NOTES §8): `approvalPolicy:"never"` does
 * NOT auto-approve MCP tool calls — every call raises a server→client
 * `mcpServer/elicitation/request` that must be answered or the turn hangs.
 */
import type { v2 } from '@eduagent/shared/protocol';
import type { ElicitationApprover, ElicitationContext } from './types.js';

/**
 * The observed elicitation carries the tool name only inside the
 * human-readable message: `Allow the <server> MCP server to run tool
 * "<tool>"?` (fixture 08). Returns the last double-quoted token, or null.
 */
export function extractElicitationToolName(message: string): string | null {
  let toolName: string | null = null;
  for (const match of message.matchAll(/"([^"]+)"/g)) {
    toolName = match[1] ?? null;
  }
  return toolName;
}

export function buildElicitationContext(
  params: v2.McpServerElicitationRequestParams,
): ElicitationContext {
  const meta: unknown = params._meta;
  const approvalKind =
    typeof meta === 'object' &&
    meta !== null &&
    'codex_approval_kind' in meta &&
    typeof (meta as { codex_approval_kind: unknown }).codex_approval_kind === 'string'
      ? (meta as { codex_approval_kind: string }).codex_approval_kind
      : null;
  const message = typeof params.message === 'string' ? params.message : '';
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    serverName: params.serverName,
    toolName: extractElicitationToolName(message),
    approvalKind,
    params,
  };
}

/**
 * Default policy (plans/03 §2): auto-accept only MCP *tool-call* approvals
 * for our `ui_*` tools; everything else is declined (and warn-logged by the
 * client). ThreadManager may inject a stricter predicate (e.g. also pinning
 * `serverName` to the ui-tools server).
 */
export const defaultElicitationApprover: ElicitationApprover = (ctx) =>
  ctx.approvalKind === 'mcp_tool_call' && ctx.toolName !== null && ctx.toolName.startsWith('ui_');
