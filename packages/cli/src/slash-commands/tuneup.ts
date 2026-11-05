import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  buildTuneupCommand as buildPortableTuneupCommand,
  type TuneupCommandHost,
} from '@wrongstack/runtime/commands';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { cliTuneupHooks } from '../tuneup-hooks.js';
import type { SlashCommandContext } from './command-context.js';

/**
 * `/tuneup` (alias `/checkup`) as the TUI runs it: the portable command with the CLI's version
 * check, config doctor and config history, writing the active profile's config file.
 */
export function buildTuneupCommand(opts: SlashCommandContext): SlashCommand {
  const host: TuneupCommandHost = Object.assign(Object.create(opts) as SlashCommandContext, {
    ...cliTuneupHooks,
    getProfileConfigPath: () =>
      opts.paths ? activeProfileConfigPath(opts.paths, opts.configStore.get()) : undefined,
  });
  return buildPortableTuneupCommand(host);
}
