import { estimateToolDefTokens } from './token-estimate.js';
import { compactToolDefinitionForWire, type ToolWireDefinitionLike } from './tool-wire-compact.js';

/** Measures the shared provider projection, excluding host-only metadata and usageHint. */
export function measureToolSchemas(tools: readonly ToolWireDefinitionLike[]) {
  const definitions = tools.map((tool) => compactToolDefinitionForWire(tool));
  return {
    count: definitions.length,
    wireBytes: new TextEncoder().encode(JSON.stringify(definitions)).byteLength,
    // An estimate with the same heuristic as runtime context accounting, not billed tokens.
    estimatedTokens: tools.reduce((sum, tool) => sum + estimateToolDefTokens(tool), 0),
  };
}
