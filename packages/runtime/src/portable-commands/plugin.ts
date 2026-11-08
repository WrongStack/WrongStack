import type { Config, SlashCommand } from '@wrongstack/contracts/types';
import { runPluginManagementCommand } from '../plugin-management/management.js';
import type { PluginManagementCommandHost } from './host.js';

/** What `/plugin` is and how to use it; the CLI's command shows the same text. */
export const PLUGIN_COMMAND_DESCRIPTION =
  'Manage plugins: /plugin [list|menu|report|official|install <alias>|enable <name>|disable <name>|toggle <name>|remove <name>|manager [lock|unlock] <name|*>|llm <name> [provider] [model]]';
export const PLUGIN_COMMAND_ARGS_HINT =
  '[list|menu|report|official|install <alias>|enable <name>|disable <name>|toggle <name>|remove <name>|manager [lock|unlock] <name|*>|llm <name> [provider] [model]]';
export const PLUGIN_COMMAND_HELP = [
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
  '  /plugin manager                         List LLM-managed plugin locks.',
  '  /plugin manager lock <name|*>           Block LLM enable/disable changes.',
  '  /plugin manager unlock <name|*>         Restore LLM enable/disable changes.',
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
  '  /plugin manager lock secret-scanner',
  '  /plugin llm error-lens omniroute qwen3-30b',
  '  /plugin llm changelog-writer anthropic claude-haiku-4-5',
].join('\n');

const RESTART_NOTE = 'Restart WrongStack to load or unload plugin code in this session.';

/**
 * `/plugin` for an engine without a terminal (the desktop's engine, `wstack
 * webui`): the CLI's plugin manager, writing the active profile's config and
 * applying the change to the running engine. Plugin code itself loads at start,
 * so a change that needs it says to restart.
 */
export function buildPluginManagementCommand(host: PluginManagementCommandHost): SlashCommand {
  return {
    name: 'plugin',
    category: 'Config',
    aliases: ['plugins'],
    description: PLUGIN_COMMAND_DESCRIPTION,
    argsHint: PLUGIN_COMMAND_ARGS_HINT,
    help: PLUGIN_COMMAND_HELP,
    async run(args) {
      const configPath = host.getProfileConfigPath?.();
      const config = host.configStore?.get();
      if (!configPath || !config) {
        return { message: 'Plugin management is not available in this session.' };
      }
      const trimmed = args.trim();
      const result = await runPluginManagementCommand(
        trimmed === '' || trimmed === 'menu' ? [] : trimmed.split(/\s+/).filter(Boolean),
        {
          config,
          configPath,
          ...(host.paths?.globalRoot ? { globalRoot: host.paths.globalRoot } : {}),
          ...(host.backupConfig ? { backupConfig: host.backupConfig } : {}),
        },
      );
      if (result.patch) {
        const patch = result.patch as never as Partial<Config>;
        if (host.applyConfigPatch) host.applyConfigPatch(patch);
        else host.configStore?.update(patch);
      }
      return {
        message:
          result.restartRequired && result.code === 0
            ? `${result.message}\n${RESTART_NOTE}`
            : result.message,
      };
    },
  };
}
