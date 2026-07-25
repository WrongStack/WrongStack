import type { ConcreteTokenSavingTier, Tool } from '@wrongstack/core/types';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { TIER1_TOOLS, TIER2_TOOLS, TIER3_TOOLS } from './builtin.js';
import { builtinToolsPack } from './pack.js';

function toolNameSet(tools: readonly (Tool | null | undefined)[]): Set<string> {
  return new Set(tools.flatMap((tool) => (tool ? [tool.name] : [])));
}

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
      const tier2Names = toolNameSet(TIER2_TOOLS);
      const tier3Names = toolNameSet(TIER3_TOOLS);
      return allTools.filter(
        (tool) =>
          tier1Names.has(tool.name) ||
          (tier2Names.has(tool.name) && tool.name !== 'task') ||
          (tier3Names.has(tool.name) && tool.name !== 'set_working_dir'),
      );
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
