/**
 * Client-supplied MCP servers for ACP sessions.
 *
 * The ACP spec lets a client hand the agent a list of MCP servers with
 * `session/new` (and `session/load` / `session/fork`): the editor owns the
 * user's MCP configuration, and the agent is expected to connect to those
 * servers and expose their tools for the session's lifetime.
 *
 * WrongStack advertised `mcpCapabilities: {http: false, sse: false}` and then
 * destructured `mcpServers` at every entry point without ever reading it — so
 * even the mandatory stdio transport was silently dropped. A client got a
 * successful `session/new` and no tools, with nothing anywhere saying why.
 * This module is the missing half: it maps the ACP wire shape onto
 * `MCPServerConfig` and drives a per-session `MCPRegistry` whose tools land in
 * that session's own `ToolRegistry` clone.
 *
 * Per-session, not per-process, deliberately: two ACP sessions may ask for
 * different servers, and closing one must not tear down the other's.
 */

import type { McpServer } from '@wrongstack/acp/agent';
import type { EventBus } from '@wrongstack/core/kernel';
import type { ToolRegistry } from '@wrongstack/core/registry';
import type { Logger, MCPServerConfig } from '@wrongstack/core/types';
import { MCPRegistry } from '@wrongstack/mcp';

/** ACP sends env vars and headers as `{name, value}[]`; config wants a record. */
function pairsToRecord(
  pairs: ReadonlyArray<{ name: string; value: string }> | undefined,
): Record<string, string> | undefined {
  if (!pairs || pairs.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const { name, value } of pairs) out[name] = value;
  return out;
}

/**
 * Translate one ACP server entry into the config shape `MCPRegistry` consumes.
 *
 * Transport names differ between the two specs: ACP's `http` is MCP's
 * `streamable-http`, and an entry with no `type` is stdio (the spec's default,
 * and the only transport a client may assume).
 */
export function acpMcpServerToConfig(server: McpServer): MCPServerConfig {
  const type = 'type' in server ? server.type : 'stdio';
  if (type === 'http' || type === 'sse') {
    const headers = pairsToRecord(
      (server as { headers?: Array<{ name: string; value: string }> }).headers,
    );
    return {
      name: server.name,
      transport: type === 'http' ? 'streamable-http' : 'sse',
      url: (server as { url: string }).url,
      ...(headers ? { headers } : {}),
      description: 'Supplied by the ACP client for this session.',
    };
  }
  const stdio = server as { command: string; args?: string[] };
  const env = pairsToRecord((server as { env?: Array<{ name: string; value: string }> }).env);
  return {
    name: server.name,
    transport: 'stdio',
    command: stdio.command,
    ...(stdio.args && stdio.args.length > 0 ? { args: [...stdio.args] } : {}),
    ...(env ? { env } : {}),
    description: 'Supplied by the ACP client for this session.',
  };
}

export interface AcpSessionMcpOptions {
  servers: readonly McpServer[];
  toolRegistry: ToolRegistry;
  events: EventBus;
  logger: Logger;
  cacheDir?: string | undefined;
}

/**
 * Connect the session's MCP servers and register their tools.
 *
 * Returns the registry so the caller can stop it when the session ends, or
 * `undefined` when the client asked for nothing. A server that fails to start
 * is logged and skipped — one unreachable server must not cost the client its
 * whole session, and the failure is visible in `wstack mcp` health output.
 */
export async function connectAcpSessionMcpServers(
  opts: AcpSessionMcpOptions,
): Promise<MCPRegistry | undefined> {
  if (opts.servers.length === 0) return undefined;
  const registry = new MCPRegistry({
    toolRegistry: opts.toolRegistry,
    events: opts.events,
    log: opts.logger,
    // Eager, not lazy: the tool list has to be complete before the session's
    // Context snapshots `listForProvider()`, which happens immediately below
    // this call. A lazily registered tool would exist in the registry but be
    // absent from the very first turn's provider payload.
    lazyMode: false,
    ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
  });
  for (const server of opts.servers) {
    try {
      await registry.start(acpMcpServerToConfig(server));
    } catch (err) {
      opts.logger.warn(`ACP client MCP server "${server.name}" failed to start`, err);
    }
  }
  return registry;
}
