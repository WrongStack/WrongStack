/**
 * MCP `initialize` results may carry `instructions`: the server's own guidance
 * on how and when to use its tools. The spec leaves it to the client to put
 * them in front of the model; a host that dropped them left the model with
 * tool names and descriptions but none of the context their author wrote.
 */

/** Per-server cap: one oversized server must not crowd out the rest of the prompt. */
export const MCP_INSTRUCTIONS_MAX_CHARS = 8_000;

interface InstructionsSource {
  list(): ReadonlyArray<{ name: string }>;
  getCatalog(
    name: string,
  ): { serverMetadata?: { instructions?: string | undefined } | undefined } | undefined;
}

/**
 * The connected servers' instructions as one system-prompt section, or
 * `undefined` when none sent any. A server that has not connected yet (lazy
 * mode) contributes once it has.
 */
export function mcpServerInstructionsSection(registry: InstructionsSource): string | undefined {
  const parts: string[] = [];
  for (const { name } of registry.list()) {
    const text = registry.getCatalog(name)?.serverMetadata?.instructions?.trim();
    if (!text) continue;
    let capped = text;
    if (text.length > MCP_INSTRUCTIONS_MAX_CHARS) {
      let end = MCP_INSTRUCTIONS_MAX_CHARS;
      const lastKept = text.charCodeAt(end - 1);
      if (lastKept >= 0xd800 && lastKept <= 0xdbff) end -= 1;
      capped = `${text.slice(0, end)}\n[instructions truncated]`;
    }
    parts.push(`## ${name}\n${capped}`);
  }
  if (parts.length === 0) return undefined;
  return [
    '# MCP server instructions',
    'Connected MCP servers sent these instructions about their own tools.',
    '',
    parts.join('\n\n'),
  ].join('\n');
}
