import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';

export function buildPluginCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'plugin',
    category: 'Config',
    aliases: ['plugins'],
    description:
      'Manage plugins: /plugin [list|menu|report|official|install <alias>|enable <name>|disable <name>|toggle <name>|remove <name>|llm <name> [provider] [model]]',
    argsHint:
      '[list|menu|report|official|install <alias>|enable <name>|disable <name>|toggle <name>|remove <name>|llm <name> [provider] [model]]',
    help: [
      'Usage:',
      '  /plugin                         List configured plugins.',
      '  /plugin status                  Alias for list.',
      '  /plugin menu                    Show curated on/off menu for safe plugin subset.',
      '  /plugin report                  Explain why plugins are active and which can be disabled.',
      '  /plugin official                List official bundled plugins and aliases.',
      '  /plugin install <alias|package> Add and enable a plugin.',
      '  /plugin add <alias|package>     Alias for install.',
      '  /plugin enable <alias|package>  Enable a configured plugin.',
      '  /plugin disable <alias|package> Disable a configured plugin.',
      '  /plugin toggle <name>           Toggle one curated plugin from the menu.',
      '  /plugin remove <alias|package>  Remove a plugin from config.',
      '  /plugin llm                              List every per-plugin LLM override.',
      '  /plugin llm <name>                       Show the per-plugin LLM override.',
      '  /plugin llm <name> <provider> [model]    Route this plugin through a provider/model.',
      '  /plugin llm <name> - <model>             Keep the session provider, override the model.',
      '  /plugin llm <name> --clear               Back to the session default (the chat leader).',
      '',
      'Examples:',
      '  /plugin menu',
      '  /plugin report',
      '  /plugin toggle format-on-save',
      '  /plugin install telegram',
      '  /plugin llm error-lens omniroute qwen3-30b',
      '  /plugin llm changelog-writer anthropic claude-haiku-4-5',
    ].join('\n'),
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
