import type { ToolRegistry } from '@wrongstack/core/registry';
import type { ConcreteTokenSavingTier, Tool } from '@wrongstack/core/types';
import { TIER1_TOOLS, TIER2_TOOLS } from './builtin.js';
import { builtinToolsPack } from './pack.js';

function toolNameSet(tools: readonly (Tool | null | undefined)[]): Set<string> {
  return new Set(tools.flatMap((tool) => (tool ? [tool.name] : [])));
}

/**
 * Live count of tools each concrete token-saving tier exposes to the provider.
 * This is the runtime source of truth — `off` counts every registered tool,
 * the other tiers count the result of `selectBuiltinToolsForTier(tier, …)`.
 *
 * Website (`website/src/pages/ToolsPage.tsx`) and any other consumer that
 * wants to render tier counts without actually loading the catalog should
 * mirror this map. When `TIER1_TOOLS` / `TIER2_TOOLS` / `TIER3_TOOLS` change,
 * regenerate these numbers from a smoke test (or update both together).
 */
export const BUILTIN_TIER_COUNTS: Readonly<Record<ConcreteTokenSavingTier, number>> = {
  off: builtinToolsPack.tools?.length ?? 0,
  minimal: TIER1_TOOLS.length,
  light: TIER1_TOOLS.length,
  medium: TIER1_TOOLS.length + TIER2_TOOLS.length,
  aggressive: TIER1_TOOLS.length,
};

/**
 * Select built-in tools for a concrete token-saving tier while preserving the
 * order and instances supplied by the caller.
 */
export function selectBuiltinToolsForTier(
  tier: ConcreteTokenSavingTier,
  allTools: readonly Tool[],
): Tool[] {
  switch (tier) {
    case 'off':
      return [...allTools];
    case 'minimal':
    case 'light': {
      const tier1Names = toolNameSet(TIER1_TOOLS);
      return allTools.filter((tool) => tier1Names.has(tool.name));
    }
    case 'medium': {
      const tier1Names = toolNameSet(TIER1_TOOLS);
      const tier2Names = toolNameSet(TIER2_TOOLS);
      return allTools.filter((tool) => tier1Names.has(tool.name) || tier2Names.has(tool.name));
    }
    case 'aggressive': {
      const tier1Names = toolNameSet(TIER1_TOOLS);
      return allTools.filter((tool) => tier1Names.has(tool.name));
    }
  }
}

export interface RegisterBuiltinToolTierOptions {
  registry: Pick<ToolRegistry, 'registerAllOrThrow'>;
  tier: ConcreteTokenSavingTier;
  tools?: readonly Tool[] | undefined;
  owner?: string | undefined;
}

/** Register the canonical built-in subset for a host and return that subset. */
export function registerBuiltinToolTier(options: RegisterBuiltinToolTierOptions): Tool[] {
  const tools = selectBuiltinToolsForTier(
    options.tier,
    options.tools ?? builtinToolsPack.tools ?? [],
  );
  options.registry.registerAllOrThrow(tools, options.owner ?? builtinToolsPack.name);
  return tools;
}
