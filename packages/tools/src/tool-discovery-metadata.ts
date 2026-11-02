import type { Tool } from '@wrongstack/contracts/types/tool';

/** Host metadata is fetched during discovery, never added to every provider request. */
export function toolDiscoveryMetadata(tool: Tool) {
  return {
    ...(tool.aliases?.length ? { aliases: tool.aliases } : {}),
    ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
    ...(tool.cost ? { cost: tool.cost } : {}),
    ...(tool.preconditions?.length ? { preconditions: tool.preconditions } : {}),
    ...(tool.idempotent !== undefined ? { idempotent: tool.idempotent } : {}),
    ...(tool.retrySafe !== undefined ? { retrySafe: tool.retrySafe } : {}),
    ...(tool.selection ? { selection: tool.selection } : {}),
    ...(tool.estimatedDurationMs !== undefined
      ? { estimatedDurationMs: tool.estimatedDurationMs }
      : {}),
  };
}
