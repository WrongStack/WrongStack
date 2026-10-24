import type { ConfigStore } from '@wrongstack/contracts/types/config/root';
import type { Tool } from '@wrongstack/contracts/types/tool';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { createJevStatusTool, createJevTool } from '@wrongstack/core/typesafe';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';

/** Keep discovery and prompt tool sets in sync with live account/feature settings. */
export function registerJevTools(registry: ToolRegistry, store: ConfigStore): () => void {
  const getConfig = () => store.get();
  const register = (tool: Tool) => {
    registry.register(tool);
    // Host tool surfaces can already be narrowed before these optional tools arrive.
    registry.exposeToProvider(tool.name);
    const config = getConfig().tools;
    if (config?.disabledTools?.includes(tool.name)) {
      registry.disable(tool.name);
      const meta = config.disabledToolMeta?.[tool.name];
      if (meta) registry.applyDisabledMeta({ [tool.name]: meta });
    }
  };
  register(createJevStatusTool(getConfig, () => registry.isDisabled('jev')));
  const tool = createJevTool(getConfig);
  const sync = () => {
    // Transient health is checked by status/execute; retain discovery during cooldowns.
    const configured = !!resolveTypeSafeJudge({ config: getConfig(), feature: 'tool' });
    if (configured && !registry.ownerOf('jev')) register(tool);
    else if (!configured) registry.unregister('jev');
  };
  sync();
  return store.watch(sync);
}
