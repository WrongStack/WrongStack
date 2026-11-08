import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  PLUGIN_COMMAND_ARGS_HINT,
  PLUGIN_COMMAND_DESCRIPTION,
  PLUGIN_COMMAND_HELP,
} from '@wrongstack/runtime/commands';
import type { SlashCommandContext } from './command-context.js';

export function buildPluginCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'plugin',
    category: 'Config',
    aliases: ['plugins'],
    description: PLUGIN_COMMAND_DESCRIPTION,
    argsHint: PLUGIN_COMMAND_ARGS_HINT,
    help: PLUGIN_COMMAND_HELP,
    async run(args) {
      const trimmed = args.trim();
      if ((trimmed === 'menu' || trimmed === '') && opts.onPanelOpen?.current) {
        const opened = opts.onPanelOpen.current('pluginPickerOpen');
        if (opened) return { message: 'Opened plugin menu.' };
      }
      if (!opts.onPlugin) {
        return { message: 'Plugin management is not available in this session.' };
      }
      return { message: await opts.onPlugin(trimmed) };
    },
  };
}
