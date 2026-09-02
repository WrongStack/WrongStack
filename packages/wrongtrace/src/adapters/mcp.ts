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

import { DEFAULT_TRANSPORT_TIMEOUT_MS } from '../constants.js';
import type { WrongTraceHealth, WrongTraceLockResult } from '../types.js';

export type McpToolName =
  | 'check_guardrail'
  | 'get_file_health_score'
  | 'get_symbol_lineage'
  | 'get_friction_matrix'
  | 'get_atlas'
  | 'lock_file'
  | 'unlock_file'
  | 'report_telemetry';

export type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type McpToolBag = Partial<Record<McpToolName, McpToolHandler>>;

export interface McpTransport {
  readonly isWired: boolean;
  readonly availableTools: McpToolName[];
  invoke<T = unknown>(tool: McpToolName, args: Record<string, unknown>): Promise<T | null>;
}

/**
 * Per-call bound — shared with httpJson via constants.ts so every transport
 * surface in this adapter carries the same latency ceiling: a hung MCP
 * bridge can never block the edit path (see hooks.ts failure philosophy:
 * coordination is an optimization, never a hard dependency).
 *
 * Cancellation note: the bound limits CALLER settlement only. When the
 * timeout branch wins, the underlying handler promise is not aborted — the
 * MCP tool contract has no abort channel, so a never-settling handler keeps
 * running (and any resources it captured stay alive) until it settles on its
 * own. Callers are bounded regardless; the outlived promise is garbage once
 * nothing references it.
 */
export function createMcpTransport(
  tools: McpToolBag = {},
  timeoutMs = DEFAULT_TRANSPORT_TIMEOUT_MS,
): McpTransport {
  const entries = Object.entries(tools).filter(([, v]) => typeof v === 'function') as Array<
    [McpToolName, McpToolHandler]
  >;
  return {
    isWired: entries.length > 0,
    availableTools: entries.map(([k]) => k),
    async invoke<T>(tool: McpToolName, args: Record<string, unknown>): Promise<T | null> {
      const handler = tools[tool];
      if (!handler) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Bound the await: a handler that never settles must resolve null
        // after timeoutMs instead of leaving the caller pending forever.
        // Promise.race consumes both settlement paths, so a late rejection
        // of the underlying handler cannot surface as an unhandled rejection.
        return (await Promise.race([
          handler(args),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), timeoutMs);
          }),
        ])) as T;
      } catch {
        return null;
      } finally {
        // Never leave the race timer dangling: when the handler wins the
        // race, a ref'ed setTimeout would hold the event loop open for the
        // remaining timeoutMs (and abandoned timers stack at higher call
        // rates). Clear it on every settlement path.
        if (timer !== undefined) clearTimeout(timer);
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
