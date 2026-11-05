import type { SlashCommand } from '@wrongstack/contracts/types';
import { updateJsonObjectFile } from '@wrongstack/core/utils';
import { buildGitIdCommand as buildPortableGitIdCommand } from '@wrongstack/runtime/commands';
import { backupCurrent } from '../config-history.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import type { SlashCommandContext } from './command-context.js';

/**
 * /gitid as the TUI runs it: the portable command, writing the active profile's config file
 * after the CLI's config-history backup.
 */
export function buildGitIdCommand(opts: SlashCommandContext): SlashCommand {
  const paths = opts.paths;
  return buildPortableGitIdCommand({
    configStore: opts.configStore,
    patchProfileConfig: paths
      ? (mutate) => {
          const globalConfigPath = activeProfileConfigPath(paths, opts.configStore.get());
          return updateJsonObjectFile(globalConfigPath, async (config) => {
            await backupCurrent(undefined, globalConfigPath);
            mutate(config);
            return config;
          });
        }
      : undefined,
  });
}
