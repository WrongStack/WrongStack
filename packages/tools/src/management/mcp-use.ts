import type { NestedToolCaller } from '@wrongstack/contracts/types/context';
import type { JSONSchema, Tool } from '@wrongstack/contracts/types/tool';
import {
  GOVERNED_TOOL_EXECUTOR_META_KEY,
  type GovernedToolExecutor,
} from '@wrongstack/contracts/types/tool-executor';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { ToolCapabilities } from '@wrongstack/core/security';
import { mcpQualifiedToolName, mcpServerToolPrefix } from '@wrongstack/core/utils';
import type { MCPRegistryHandle } from './mcp-control.js';

/**
 * `mcp_use` — meta-tool for ephemeral MCP tool calls in token-saving mode.
 *
 * Instead of the 4-step manual cycle (list → activate → use → deactivate),
 * the model calls this single tool. It:
 *  1. Activates the server's tools in the registry
 *  2. Calls the requested tool with the provided input
 *  3. Returns the result
 *  4. Deactivates the server's tools
 *
 * The tool is registered only when features.lazyMcp is active so the model
 * always has a way to reach MCP tools without them being in the prompt.
 */

export interface CreateMcpUseToolOptions {
  /** Live MCP registry handle (activate/deactivate/describe). */
  registry: MCPRegistryHandle;
  /** Tool registry — needed to resolve and call MCP tools by name. */
  toolRegistry: ToolRegistry;
}

/** Registry states in which a tool call can proceed (dormant wakes on demand). */
const MCP_USE_CALLABLE_STATES: ReadonlySet<string> = new Set(['connected', 'dormant']);

/** Per-registry, per-server count of in-flight mcp_use calls holding an activation. */
const activationLeaseMaps = new WeakMap<object, Map<string, number>>();

function activationLeasesFor(registry: MCPRegistryHandle): Map<string, number> {
  let leases = activationLeaseMaps.get(registry);
  if (!leases) {
    leases = new Map();
    activationLeaseMaps.set(registry, leases);
  }
  return leases;
}

export function createMcpUseTool(opts: CreateMcpUseToolOptions): Tool {
  const { registry, toolRegistry } = opts;

  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description:
          'MCP server name (e.g. "github", "filesystem", "brave-search"). Use mcp_control list first to discover available servers.',
      },
      tool: {
        type: 'string',
        description:
          'Bare tool name on the MCP server (no mcp__server__ prefix). Get the exact names from mcp_control({ action: "tools", server }).',
      },
      input: {
        type: 'object',
        description:
          'JSON input matching the tool\'s input schema, as listed by mcp_control({ action: "tools", server }).',
        properties: {},
        additionalProperties: true,
      },
    },
    required: ['server', 'tool', 'input'],
  };

  return {
    name: 'mcp_use',
    description:
      'Call an MCP tool on a lazy-loaded server. Activates the server temporarily (starting a sleeping server), calls the tool, returns the result, and deactivates. Use this instead of the manual activate→use→deactivate cycle. Find the server with mcp_control list, and the exact tool name and input schema with mcp_control({ action: "tools", server }).',
    category: 'mcp',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: [ToolCapabilities.MCP_PROXY],
    inputSchema,
    async execute(raw, ctx, opts) {
      const input = raw as {
        server: string;
        tool: string;
        input?: Record<string, unknown> | undefined;
      };

      const { server: serverName, tool: toolName, input: toolInput } = input;

      // Validate server exists. Lookup failures THROW so the executor records
      // a failed call — a plain string return was recorded as success, which
      // hid every misrouted call from failure accounting and retry logic.
      const servers = registry.describe();
      const serverInfo = servers.find((s) => s.name === serverName);
      if (!serverInfo) {
        throw new Error(
          `Server "${serverName}" not found. Available: ${servers.map((s) => s.name).join(', ') || 'none'}.`,
        );
      }
      // `dormant` is the NORMAL resting state of a lazy server (booted from its
      // manifest, or asleep after the idle timeout): its tool wrappers spawn
      // the process on the call. Rejecting it made the gateway unusable for
      // exactly the servers it exists to reach.
      if (!MCP_USE_CALLABLE_STATES.has(serverInfo.state)) {
        throw new Error(
          `Server "${serverName}" is not available (state: ${serverInfo.state}). Use \`mcp_control({ action: "${serverInfo.state === 'failed' || serverInfo.state === 'disconnected' ? 'restart' : 'enable'}", server: "${serverName}" })\` first.`,
        );
      }

      // Activate server tools unless the operator already did (an mcp_control
      // activation must survive this call). Concurrent mcp_use calls share one
      // activation through a lease count: without it the first call to finish
      // deactivated the server under a sibling that had not resolved its tool.
      const leases = activationLeasesFor(registry);
      const held = leases.get(serverName) ?? 0;
      const alreadyActive = held === 0 && registry.isActivated?.(serverName) === true;
      const leased = !alreadyActive && Boolean(registry.activateServer);
      if (leased) {
        if (held === 0) registry.activateServer?.(serverName);
        leases.set(serverName, held + 1);
      }

      try {
        // Resolve the qualified tool name
        const qualifiedName = mcpQualifiedToolName(serverName, toolName);
        const mcpTool = toolRegistry.get(qualifiedName);
        if (!mcpTool) {
          // Tool not found — list available tools for helpful error
          const allTools = toolRegistry
            .list()
            .filter((t) => t.name.startsWith(mcpServerToolPrefix(serverName)))
            .map((t) => t.name.replace(mcpServerToolPrefix(serverName), ''));
          const hint =
            allTools.length > 0
              ? `Available tools on "${serverName}": ${allTools.join(', ')}.`
              : `No tools found on "${serverName}". The server may not have published any tools.`;
          throw new Error(`Tool "${toolName}" not found on server "${serverName}". ${hint}`);
        }

        // The agent's own gate first (see tool_use): it can ask the user to
        // confirm an MCP tool, which the executor bridge below cannot.
        const caller = (ctx as { nestedToolCall?: NestedToolCaller | undefined }).nestedToolCall;
        if (caller) {
          const nested = await caller({
            name: qualifiedName,
            input: toolInput ?? {},
            parentToolUseId: opts?.toolUseId ?? `mcp-use-${Date.now().toString(36)}`,
            index: 1,
          });
          if (nested.isError) throw new Error(nested.content || 'MCP tool execution failed');
          return nested.content;
        }

        const governedExecute = ctx.meta[GOVERNED_TOOL_EXECUTOR_META_KEY] as
          | GovernedToolExecutor
          | undefined;
        if (typeof governedExecute !== 'function') {
          throw new Error('mcp_use: governed nested execution is unavailable');
        }
        const result = await governedExecute(qualifiedName, toolInput ?? {});
        if (!result.success) throw new Error(result.error ?? 'MCP tool execution failed');
        return result.result;
      } finally {
        // Release this call's lease (even if the tool call threw); the last
        // holder deactivates. Pre-existing activations belong to the operator.
        if (leased) {
          const remaining = (leases.get(serverName) ?? 1) - 1;
          if (remaining > 0) {
            leases.set(serverName, remaining);
          } else {
            leases.delete(serverName);
            registry.deactivateServer?.(serverName);
          }
        }
      }
    },
  };
}
