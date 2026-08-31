import { ToolCapabilities } from '@wrongstack/core/security';
import type { Permission, Tool } from '@wrongstack/core/types';
import { mcpQualifiedToolName } from '@wrongstack/core/utils';
import type { MCPClient } from './client.js';
import type { MCPTool } from './contracts.js';

/**
 * Keywords that indicate a mutating operation.
 * Applied to both the tool name and its inputSchema property names.
 */
const MUTATING_RE = /create|update|delete|write|send|set|put|post|patch|remove|rename|move/i;

function isMutatingTool(mcpTool: MCPTool): boolean {
  if (MUTATING_RE.test(mcpTool.name)) return true;
  // Check property names in the input schema for mutating intent.
  // e.g. { properties: { createTable: {...}, dropIndex: {...} } }
  const schema = mcpTool.inputSchema;
  if (schema && typeof schema === 'object') {
    const props = (schema as { properties?: Record<string, unknown> }).properties;
    if (props) {
      for (const key of Object.keys(props)) {
        if (MUTATING_RE.test(key)) return true;
      }
    }
  }
  return false;
}

/**
 * Resolves the live client for a tool call. A plain {@link MCPClient} for eager
 * servers, or a thunk that connects-on-demand for lazy/dormant servers (the
 * registry passes `() => this.ensureConnected(name)`).
 */
export type MCPClientResolver = MCPClient | (() => Promise<MCPClient>);

export interface MCPToolCallObserver {
  onStart(): void;
  onFinish(result: { durationMs: number; ok: boolean }): void;
}

export function wrapMCPTool(
  serverName: string,
  mcpTool: MCPTool,
  client: MCPClientResolver,
  permission: Permission = 'confirm',
  observer?: MCPToolCallObserver | undefined,
): Tool {
  // Sanitized to the provider-wire pattern ^[a-zA-Z0-9_-]{1,128}$ — server
  // names and remote tool names may contain dots/colons/spaces that
  // Anthropic-family endpoints reject with a 400. The remote call below
  // still uses the original `mcpTool.name`.
  const qualifiedName = mcpQualifiedToolName(serverName, mcpTool.name);
  return {
    name: qualifiedName,
    description: mcpTool.description ?? `${qualifiedName} (MCP tool)`,
    usageHint: `Tool provided by MCP server "${serverName}". ${mcpTool.description ?? ''}`,
    permission,
    mutating: isMutatingTool(mcpTool),
    capabilities: [ToolCapabilities.MCP_PROXY],
    inputSchema: mcpTool.inputSchema ?? { type: 'object', properties: {} },
    async execute(input, ctx, opts) {
      const startedAt = Date.now();
      observer?.onStart();
      let ok = false;
      try {
        // For a dormant lazy server this spawns the process + handshakes before
        // the first call; for an eager server it resolves to the fixed client.
        const live = typeof client === 'function' ? await client() : client;
        // Propagate the run's abort signal: on Ctrl+C the JSON-RPC request is
        // dropped AND the server is told via `notifications/cancelled` to stop
        // the in-flight work, instead of it running to completion server-side.
        const signal = opts?.signal ?? ctx?.signal;
        const res = await live.callTool(mcpTool.name, input, signal ? { signal } : undefined);
        if (res.isError) {
          throw new Error(stringify(res.content));
        }
        ok = true;
        return stringify(res.content);
      } finally {
        observer?.onFinish({ durationMs: Date.now() - startedAt, ok });
      }
    },
  };
}

function stringify(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .map((item) => {
        if (item && typeof item === 'object') {
          const t = (item as { type?: string | undefined; text?: string | undefined }).type;
          if (t === 'text') return (item as { text?: string | undefined }).text ?? '';
          return JSON.stringify(item);
        }
        return String(item);
      })
      .join('\n');
  }
  if (c && typeof c === 'object') {
    if ('text' in (c as Record<string, unknown>)) {
      return String((c as Record<string, unknown>).text);
    }
    return JSON.stringify(c);
  }
  return String(c ?? '');
}
