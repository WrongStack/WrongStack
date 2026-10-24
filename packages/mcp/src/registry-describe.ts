import type { MCPServerConfig } from '@wrongstack/contracts/types';
import type { ConnectionState, MCPToolAnnotations } from './contracts.js';
import type { ServerSlot } from './registry-slots.js';

/** Snapshot shapes `MCPRegistry` reports for its servers (list/describe/health/describeTools). */

/** One server's tool, as `MCPRegistry.describeTools()` reports it. */
export interface MCPDescribedTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
  annotations?: MCPToolAnnotations | undefined;
}

/**
 * Resolve the live tool names for a slot — the registered names in normal
 * mode, or the cached lazy-tool names when running in lazy mode (where
 * tools are connected but intentionally not registered).
 */
export function toolNamesForSlot(s: ServerSlot): string[] {
  return s.toolNames.length > 0 ? s.toolNames.slice() : (s.lazyTools ?? []).map((t) => t.name);
}

/** Body of `MCPRegistry.describeTools()` for a registered slot (honors `allowedTools`). */
export function describeSlotTools(slot: ServerSlot): MCPDescribedTool[] {
  const allowed = slot.cfg.allowedTools;
  const tools = slot.discoveredTools ?? slot.client?.listTools() ?? [];
  return tools
    .filter((tool) => !allowed || allowed.includes(tool.name))
    .map((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: structuredClone(tool.inputSchema),
      // Behaviour hints the SERVER claimed (already sanitized to the five
      // known keys by normalizeMCPTools). Surfaced for the operator only:
      // nothing in the permission path reads this field.
      ...(tool.annotations ? { annotations: structuredClone(tool.annotations) } : {}),
    }));
}

export function listServers(
  servers: Map<string, ServerSlot>,
): { name: string; state: ConnectionState; toolCount: number; tools: string[] }[] {
  return Array.from(servers.values()).map((s) => {
    const tools = toolNamesForSlot(s);
    return {
      name: s.cfg.name,
      state: s.state,
      toolCount: tools.length,
      tools,
    };
  });
}

/** Body of `MCPRegistry.describe()` — active slots followed by configured-off servers. */
export function describeServers(
  servers: Map<string, ServerSlot>,
  disabledServers: Map<string, MCPServerConfig>,
): {
  name: string;
  state: ConnectionState;
  toolCount: number;
  enabled: boolean;
  tools: string[];
}[] {
  const active = Array.from(servers.values()).map((s) => {
    const tools = toolNamesForSlot(s);
    return {
      name: s.cfg.name,
      state: s.state,
      toolCount: tools.length,
      enabled: s.cfg.enabled !== false,
      tools,
    };
  });
  const disabled = Array.from(disabledServers.values()).map((cfg) => ({
    name: cfg.name,
    state: 'idle' as const,
    toolCount: 0,
    enabled: false,
    tools: [],
  }));
  return [...active, ...disabled];
}

export function serverHealth(
  servers: Map<string, ServerSlot>,
): { name: string; alive: boolean; latencyMs?: number | undefined }[] {
  return Array.from(servers.values()).map((s) => ({
    name: s.cfg.name,
    alive: s.state === 'connected',
  }));
}
