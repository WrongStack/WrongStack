import type { MCPTool } from './contracts.js';

export function normalizeMCPTools(value: unknown): MCPTool[] {
  if (!Array.isArray(value)) return [];
  const tools: MCPTool[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const t = raw as {
      name?: unknown | undefined;
      description?: unknown | undefined;
      inputSchema?: unknown | undefined;
    };
    if (typeof t.name !== 'string') continue;
    const name = t.name.trim();
    if (name.length === 0) continue;
    const inputSchema =
      t.inputSchema && typeof t.inputSchema === 'object' && !Array.isArray(t.inputSchema)
        ? (t.inputSchema as Record<string, unknown>)
        : { type: 'object', properties: {} };
    // Log when a tool's schema is absent or invalid — this could indicate a
    // broken, misbehaving, or (if the server is untrusted) adversarial MCP
    // server trying to confuse the LLM with misleading type info.
    if (!t.inputSchema || typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema)) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'mcp.tool_schema_invalid',
          tool: name,
          message: 'no/invalid inputSchema — defaulting to empty object',
          timestamp: new Date().toISOString(),
        }),
      );
    }
    tools.push({
      name,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      inputSchema,
    });
  }
  return tools;
}
