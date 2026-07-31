/**
 * Provider-wire tool name constraints.
 *
 * Anthropic-family endpoints (including gateways that translate to the
 * Anthropic wire, e.g. OmniRoute routing to `cc/...` models) validate every
 * tool name against `^[a-zA-Z0-9_-]{1,128}$` and reject the whole request
 * with a 400 (`tools.N.custom.name: String should match pattern ...`) when
 * one name contains a dot, colon, space, or exceeds 128 chars. MCP server
 * names and remote MCP tool names are user/third-party controlled, so the
 * qualified `mcp__<server>__<tool>` names must be sanitized at registration
 * time — the registry, permission policy, and provider wire all see the
 * same sanitized name, so no reverse mapping is needed on the response
 * path. The wrapped tool still calls the remote server with the ORIGINAL
 * tool name.
 */

export const WIRE_TOOL_NAME_MAX_LENGTH = 128;
export const WIRE_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Coerce an arbitrary string into a provider-safe tool name: every char
 * outside `[a-zA-Z0-9_-]` becomes `_`, and the result is clamped to 128
 * chars (clamped from the end so namespace prefixes like `mcp__server__`
 * survive). Empty input falls back to `'tool'`.
 */
export function sanitizeWireToolName(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const clamped = replaced.slice(0, WIRE_TOOL_NAME_MAX_LENGTH);
  return clamped.length > 0 ? clamped : 'tool';
}

/** Sanitized `mcp__<server>__` namespace prefix for a server's tools. */
export function mcpServerToolPrefix(serverName: string): string {
  return `mcp__${sanitizeWireToolName(serverName)}__`;
}

/**
 * Build the qualified registry/wire name for an MCP tool. Both the server
 * segment and the tool segment are sanitized independently (so the `__`
 * separators stay intact for prefix matching), then the whole name is
 * clamped to the 128-char wire limit.
 */
export function mcpQualifiedToolName(serverName: string, toolName: string): string {
  return sanitizeWireToolName(
    `${mcpServerToolPrefix(serverName)}${sanitizeWireToolName(toolName)}`,
  );
}
