import type { JSONSchema, ToolRegistry } from '../index.js';
import { ToolCapabilities } from '../security/capabilities.js';
import { mcpQualifiedToolName, mcpServerToolPrefix } from '../utils/tool-name.js';
import type { MCPRegistryHandle } from './mcp-control.js';
import type { Tool } from '../types/tool.js';

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

export function createMcpUseTool(opts: CreateMcpUseToolOptions): Tool {
  const { registry, toolRegistry } = opts;

  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP server name (e.g. "github", "filesystem", "brave-search"). Use mcp_control list or search first to discover available servers.',
      },
      tool: {
        type: 'string',
        description: 'Tool name on the MCP server to call (without the mcp__server__ prefix — just the bare tool name).',
      },
      input: {
        type: 'object',
        description: 'JSON input to pass to the tool. Use the tool\'s own input schema — check with mcp_control describe or the server\'s documentation.',
        properties: {},
        additionalProperties: true,
      },
    },
    required: ['server', 'tool', 'input'],
  };

  return {
    name: 'mcp_use',
    description:
      'Call an MCP tool on a lazy-loaded server. Activates the server temporarily, calls the tool, returns the result, and deactivates. Use this instead of the manual activate→use→deactivate cycle. First call mcp_control list/search to find the right server and tool name.',
    category: 'mcp',
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: [ToolCapabilities.MCP_PROXY],
    inputSchema,
    async execute(raw) {
      const input = raw as {
        server: string;
        tool: string;
        input?: Record<string, unknown> | undefined;
      };

      const { server: serverName, tool: toolName, input: toolInput } = input;

      // Validate server exists
      const servers = registry.describe();
      const serverInfo = servers.find((s) => s.name === serverName);
      if (!serverInfo) {
        return `Server "${serverName}" not found. Available: ${servers.map((s) => s.name).join(', ') || 'none'}.`;
      }
      if (serverInfo.state !== 'connected') {
        return `Server "${serverName}" is not connected (state: ${serverInfo.state}). Use \`mcp_control({ action: "enable", server: "${serverName}" })\` first.`;
      }

      // Activate server tools
      if (registry.activateServer) {
        registry.activateServer(serverName);
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
          return `Tool "${toolName}" not found on server "${serverName}". ${hint}`;
        }

        // Call the tool — we need to create a minimal Context and ExecuteOptions.
        // The tool executor normally provides these; since we're calling a tool
        // from inside another tool we create minimal stubs that let the tool
        // execute its MCP transport call without needing the full agent context.
        const result = await mcpTool.execute(toolInput ?? {}, {} as never, {} as never);
        return result;
      } finally {
        // Always deactivate, even if the tool call threw
        if (registry.deactivateServer) {
          registry.deactivateServer(serverName);
        }
      }
    },
  };
}
