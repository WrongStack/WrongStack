import { runPluginManagementCommand } from '../../plugin-management.js';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import type { SubcommandHandler } from '../contracts.js';
import { restoreFlags } from '../flags.js';

export const pluginCmd: SubcommandHandler = async (args, deps) => {
  // `parseArgs` strips these before the dispatcher calls us — see restoreFlags.
  // Without them `plugin add X --disabled` wrote it ENABLED and printed
  // "(enabled)", and `plugin toggle` lost its own switches.
  args = restoreFlags(args, deps, ['disabled', 'enable', 'e', 'json', 'all']);
  const result = await runPluginManagementCommand(args, {
    config: deps.config,
    configPath: activeProfileConfigPath(deps.paths, deps.config),
  });
  if (result.level === 'error') {
    deps.renderer.writeError(`${result.message}\n`);
  } else if (result.level === 'info') {
    deps.renderer.writeInfo(`${result.message}\n`);
  } else {
    deps.renderer.write(`${result.message}\n`);
  }
  return result.code;
};

export const usageCmd: SubcommandHandler = async (_args, deps) => {
  if (!deps.sessionStore) return 0;
  const list = await deps.sessionStore.list(100);
  let totalIn = 0;
  for (const s of list) totalIn += s.tokenTotal;
  deps.renderer.write(`Sessions: ${list.length}  total tokens: ${totalIn}\n`);
  return 0;
};
