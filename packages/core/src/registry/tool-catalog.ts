import type { Tool } from '@wrongstack/contracts/types/tool';

/** Explicit projection: executable functions and private registry fields never escape. */
export function projectToolCatalogEntry(tool: Tool, owner: string, direct: boolean) {
  return {
    name: tool.name,
    owner,
    description: tool.description ?? '',
    permission: tool.permission,
    mutating: tool.mutating,
    exposure:
      tool.exposure === 'internal'
        ? ('internal' as const)
        : direct
          ? ('direct' as const)
          : ('on-demand' as const),
    capabilities: [...(tool.capabilities ?? [])],
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    ...(tool.icon ? { icon: tool.icon } : {}),
    ...(tool.riskTier ? { riskTier: tool.riskTier } : {}),
    ...(tool.category ? { category: tool.category } : {}),
    ...(tool.usageHint ? { usageHint: tool.usageHint } : {}),
    ...(tool.selection ? { selection: tool.selection } : {}),
    ...(tool.aliases?.length ? { aliases: [...tool.aliases] } : {}),
    ...(tool.deprecated ? { deprecated: { ...tool.deprecated } } : {}),
    ...(tool.preconditions ? { preconditions: [...tool.preconditions] } : {}),
    ...(tool.idempotent !== undefined ? { idempotent: tool.idempotent } : {}),
    ...(tool.retrySafe !== undefined ? { retrySafe: tool.retrySafe } : {}),
    ...(tool.cost ? { cost: { ...tool.cost } } : {}),
    ...(tool.estimatedDurationMs !== undefined
      ? { estimatedDurationMs: tool.estimatedDurationMs }
      : {}),
  };
}

export type ToolCatalogEntry = ReturnType<typeof projectToolCatalogEntry>;

/** Declaration diagnostics, never a replacement for the runtime permission policy. */
export function toolContractIssues(tool: Tool): string[] {
  const issues: string[] = [];
  if (typeof tool.description !== 'string' || !tool.description.trim())
    issues.push('MISSING_DESCRIPTION');
  if (!/^[a-zA-Z0-9_-]+$/.test(tool.name)) issues.push('INVALID_NAME');
  if (tool.permission === 'auto' && tool.riskTier === 'destructive')
    issues.push('AUTO_DESTRUCTIVE');
  if (tool.permission === 'auto' && tool.mutating) issues.push('AUTO_MUTATION_REQUIRES_REVIEW');
  if (
    tool.permission === 'auto' &&
    tool.capabilities?.some(
      (cap) =>
        cap.startsWith('shell.') ||
        cap === 'fs.write' ||
        cap.startsWith('fs.write.') ||
        (cap.startsWith('coordination.fleet.') && cap !== 'coordination.fleet.read') ||
        cap === 'config.mutate' ||
        cap === 'tool.mutate.any' ||
        cap === 'mcp.proxy' ||
        cap === 'package.install' ||
        cap.startsWith('fleet.'),
    )
  )
    issues.push('AUTO_HIGH_IMPACT');
  return issues;
}
