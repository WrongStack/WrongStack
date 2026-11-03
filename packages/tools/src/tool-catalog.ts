import type { ConcreteTokenSavingTier } from '@wrongstack/contracts/types';
import { ToolRegistry } from '@wrongstack/core/registry';
import { builtinTools } from './builtin.js';
import { getToolIcon, TOOL_ICON_CONFIG } from './tool-icons.js';
import { selectBuiltinToolsForTier } from './tool-tier.js';

/** Same projection for checked-in built-ins and the current host's late-bound catalog. */
export function exportToolCatalog(registry: ToolRegistry) {
  const catalog = registry.exportCatalog();
  return {
    ...catalog,
    tools: catalog.tools.map((tool) => {
      const icon = tool.icon ?? getToolIcon(tool.name);
      return { ...tool, icon, color: TOOL_ICON_CONFIG[icon].color };
    }),
  };
}

export function createBuiltinToolCatalog(tier: ConcreteTokenSavingTier = 'off') {
  const registry = new ToolRegistry();
  registry.registerAllOrThrow(builtinTools, 'builtin-tools');
  registry.setProviderToolNames(
    selectBuiltinToolsForTier(tier, builtinTools).map((tool) => tool.name),
  );
  return { ...exportToolCatalog(registry), scope: 'builtins' as const, tier };
}
