/**
 * Leaf contract types for the @wrongstack/mcp public surface.
 *
 * Lives separately from `client.ts` so callers (transport implementations,
 * schema normalisers, registry helpers) can depend on the wire-level types
 * without pulling in the MCP client implementation. Breaks the long-standing
 * type-level SCC ARCH-CYCLE-TYPE-17 where `client.ts` both homed the shared
 * contracts and was imported back by every transport/schema module.
 *
 * This module MUST contain no runtime imports.
 */

/** Connection lifecycle states for an MCP client. */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed'
  /** Lazy server: registered from a cached manifest, process not spawned. */
  | 'dormant';

/** Minimal MCP tool descriptor returned by `tools/list`. */
export interface MCPTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

/** Result envelope returned by an MCP `tools/call`. */
export interface ToolCallResult {
  content: unknown;
  isError: boolean;
}

/** JSON-RPC 2.0 response shape (success or error). */
export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown | undefined;
  error?: { code: number | undefined; message: string; data?: unknown | undefined } | undefined;
}
