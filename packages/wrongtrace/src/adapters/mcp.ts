/**
 * MCP transport adapter for WrongTrace.
 *
 * When the daemon is exposed as an MCP server (e.g. via `wrongtrace mcp`),
 * the integration protocol can call its tools directly instead of HTTP.
 * The adapter hides the lookup so `WrongTraceClient` can stay oblivious.
 *
 * MCP discovery is lazy: the adapter does NOT require the MCP SDK at
 * construction time. We accept a `tools` bag from the caller — typically
 * populated from `mcp_control.list()` in the host runtime. If no tools
 * are provided, every call resolves with `null`, same as HTTP/IPC
 * failure paths.
 */

import type { WrongTraceHealth, WrongTraceLockResult } from "../types.js";

export type McpToolName =
  | "check_guardrail"
  | "get_file_health_score"
  | "get_symbol_lineage"
  | "get_friction_matrix"
  | "get_atlas"
  | "lock_file"
  | "unlock_file"
  | "report_telemetry";

export type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type McpToolBag = Partial<Record<McpToolName, McpToolHandler>>;

export interface McpTransport {
  readonly isWired: boolean;
  readonly availableTools: McpToolName[];
  invoke<T = unknown>(tool: McpToolName, args: Record<string, unknown>): Promise<T | null>;
}

export function createMcpTransport(tools: McpToolBag = {}): McpTransport {
  const entries = Object.entries(tools).filter(([, v]) => typeof v === "function") as Array<
    [McpToolName, McpToolHandler]
  >;
  return {
    isWired: entries.length > 0,
    availableTools: entries.map(([k]) => k),
    async invoke<T>(tool: McpToolName, args: Record<string, unknown>): Promise<T | null> {
      const handler = tools[tool];
      if (!handler) return null;
      try {
        return (await handler(args)) as T;
      } catch {
        return null;
      }
    },
  };
}

// Convenience mappers — keep the spec endpoints ↔ MCP tool names in one place
// so future renames only need to touch this file.

export const mcp = {
  health(_health: WrongTraceHealth | null): McpToolName | null {
    return null; // `/api/health` is HTTP-only by spec
  },
  lockResult(result: WrongTraceLockResult | null): WrongTraceLockResult | null {
    return result;
  },
};
