/**
 * The terminal session's MCP server instructions in its system prompt.
 *
 * The prompt builder is bound before the MCP registry exists (the registry
 * needs the tool registry the builder's host wires first), so the registry is
 * handed over through this holder once it is built. The contributor reads it at
 * every prompt build, so a lazily connected server's instructions appear from
 * the first build after it connects.
 */

import type { SystemPromptContributor } from '@wrongstack/contracts/types';
import { type MCPRegistry, mcpServerInstructionsSection } from '@wrongstack/mcp';

const holder: { registry: MCPRegistry | undefined } = { registry: undefined };

/** Called by the lifecycle wiring once the session's MCP registry exists. */
export function setPromptMcpRegistry(registry: MCPRegistry | undefined): void {
  holder.registry = registry;
}

export const mcpInstructionsContributor: SystemPromptContributor = async () => {
  const text = holder.registry ? mcpServerInstructionsSection(holder.registry) : undefined;
  return text ? [{ type: 'text', text }] : [];
};
