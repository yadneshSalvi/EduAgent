/**
 * MCP server registration via spawn-time CLI overrides — the mechanism
 * verified in Phase 0 (PROTOCOL_NOTES §8):
 *
 *   codex app-server \
 *     -c 'mcp_servers.<name>.command="node"' \
 *     -c 'mcp_servers.<name>.args=["/abs/path/server.mjs"]'
 */
import type { McpServerSpec } from './types.js';

/** TOML bare keys — also keeps names from injecting into the config path. */
const TOML_BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function renderMcpConfigArgs(servers: Record<string, McpServerSpec> = {}): string[] {
  const args: string[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!TOML_BARE_KEY.test(name)) {
      throw new Error(
        `invalid MCP server name ${JSON.stringify(name)} — must match ${String(TOML_BARE_KEY)}`,
      );
    }
    args.push('-c', `mcp_servers.${name}.command=${JSON.stringify(spec.command)}`);
    if (spec.args !== undefined) {
      args.push('-c', `mcp_servers.${name}.args=${JSON.stringify(spec.args)}`);
    }
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      // TOML inline table ({KEY = "value"}); command/args rendering is spike-
      // verified, env rendering is not — Phase 2 must verify before relying on it.
      const entries = Object.entries(spec.env).map(([key, value]) => {
        if (!TOML_BARE_KEY.test(key)) {
          throw new Error(
            `invalid MCP env key ${JSON.stringify(key)} for server "${name}" — must match ${String(TOML_BARE_KEY)}`,
          );
        }
        return `${key} = ${JSON.stringify(value)}`;
      });
      args.push('-c', `mcp_servers.${name}.env={${entries.join(', ')}}`);
    }
  }
  return args;
}
