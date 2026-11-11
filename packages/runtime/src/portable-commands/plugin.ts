import type { Config, SlashCommand } from '@wrongstack/contracts/types';
import { runPluginManagementCommand } from '../plugin-management/management.js';
import {
  normalizePluginReloadTarget,
  PluginDevWatchController,
} from '../plugin-management/plugin-watch.js';
import type { PluginManagementCommandHost } from './host.js';

/** What `/plugin` is and how to use it; the CLI's command shows the same text. */
export const PLUGIN_COMMAND_DESCRIPTION =
  'Manage plugins: /plugin [list|menu|report|official|reload [name|--all]|trust [name|--remove]|watch [name|off]|install <alias>|enable <name>|disable <name>|toggle <name>|remove <name>|manager [lock|unlock] <name|*>|llm <name> [provider] [model]]';
export const PLUGIN_COMMAND_ARGS_HINT =
  '[list|menu|report|official|reload [name|--all]|trust [name|--remove]|watch [name|off]|install <alias>|enable <name>|disable <name>|toggle <name>|remove <name>|manager [lock|unlock] <name|*>|llm <name> [provider] [model]]';
export const PLUGIN_COMMAND_HELP = [
  'Usage:',
  '  /plugin                         List configured plugins.',
  '  /plugin status                  Alias for list.',
  '  /plugin menu                    Show curated on/off menu for safe plugin subset.',
  '  /plugin report                  Explain why plugins are active and which can be disabled.',
  '  /plugin official                List official bundled plugins and aliases.',
  '  /plugin reload [name|--all]     Hot-reload external (.ts/.js) plugins without restarting.',
  '  /plugin trust [name|--remove]   List or re-pin external plugin closure trust and hot-reload.',
  '  /plugin watch [name|off]        Auto-reload a user-global (~/.wrongstack/plugins/<name>) plugin on edit.',
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
  '  /plugin reload',
  '  /plugin reload --all',
  '  /plugin reload my-custom-tool',
  '  /plugin trust my-custom-tool',
  '  /plugin watch my-custom-tool',
  '  /plugin watch off',
  '  /plugin report',
  '  /plugin toggle format-on-save',
  '  /plugin install telegram',
  '  /plugin manager lock secret-scanner',
  '  /plugin llm error-lens omniroute qwen3-30b',
  '  /plugin llm changelog-writer anthropic claude-haiku-4-5',
].join('\n');

const RESTART_NOTE = 'Restart WrongStack to load or unload plugin code in this session.';

export function formatPluginReloadReport(
  report: { reloaded: string[]; unloaded: string[]; failed: string[] },
  targetName?: string,
): string {
  const parts: string[] = [];
  if (report.reloaded.length > 0) {
    parts.push(`Reloaded: ${report.reloaded.join(', ')}`);
  }
  if (report.unloaded.length > 0) {
    parts.push(`Unloaded: ${report.unloaded.join(', ')}`);
  }
  if (report.failed.length > 0) {
    parts.push(
      `Failed (previous active version kept where available): ${report.failed.join(', ')}`,
    );
  }
  if (parts.length === 0) {
    return targetName
      ? `No active or discoverable external plugin matched "${targetName}".`
      : 'No external plugins found to reload.';
  }
  return parts.join('\n');
}

export function extractPinnedTrustTarget(tokens: readonly string[]): string | undefined {
  if (tokens[0] !== 'trust') return undefined;
  const rest = tokens.slice(1);
  if (rest.includes('--list') || rest.includes('--remove') || rest.includes('--unpin')) {
    return undefined;
  }
  return rest.find((arg) => !arg.startsWith('--'));
}

/**
 * `/plugin` for an engine without a terminal (the desktop's engine, `wstack
 * webui`): the CLI's plugin manager, writing the active profile's config and
 * applying the change to the running engine.
 */
export function buildPluginManagementCommand(host: PluginManagementCommandHost): SlashCommand {
  const ownedWatchController = host.pluginWatchController ?? new PluginDevWatchController();
  return {
    name: 'plugin',
    category: 'Config',
    aliases: ['plugins'],
    description: PLUGIN_COMMAND_DESCRIPTION,
    argsHint: PLUGIN_COMMAND_ARGS_HINT,
    help: PLUGIN_COMMAND_HELP,
    async run(args) {
      const trimmed = args.trim();
      const tokens =
        trimmed === '' || trimmed === 'menu' ? [] : trimmed.split(/\s+/).filter(Boolean);
      if (tokens[0] === 'reload') {
        if (!host.reloadPlugins) {
          return { message: `Live plugin reload is not wired in this host.\n${RESTART_NOTE}` };
        }
        const targetName = normalizePluginReloadTarget(tokens[1]);
        const report = await host.reloadPlugins(targetName);
        return { message: formatPluginReloadReport(report, targetName) };
      }
      if (tokens[0] === 'watch') {
        if (!host.reloadPlugins) {
          return { message: `Live plugin watch is not wired in this host.\n${RESTART_NOTE}` };
        }
        const message = await ownedWatchController.handleCommand(tokens.slice(1), {
          globalRoot: host.paths?.globalRoot,
          projectRoot: host.projectRoot,
          onReload: host.reloadPlugins,
        });
        return { message };
      }
      const configPath = host.getProfileConfigPath?.();
      const config = host.configStore?.get();
      if (!configPath || !config) {
        return { message: 'Plugin management is not available in this session.' };
      }
      const result = await runPluginManagementCommand(tokens, {
        config,
        configPath,
        ...(host.projectRoot ? { projectRoot: host.projectRoot } : {}),
        ...(host.paths?.globalRoot ? { globalRoot: host.paths.globalRoot } : {}),
        ...(host.backupConfig ? { backupConfig: host.backupConfig } : {}),
      });
      if (result.patch) {
        const patch = result.patch as never as Partial<Config>;
        if (host.applyConfigPatch) host.applyConfigPatch(patch);
        else host.configStore?.update(patch);
      }
      const trustTarget = result.code === 0 ? extractPinnedTrustTarget(tokens) : undefined;
      if ((result.restartRequired || trustTarget !== undefined) && result.code === 0) {
        if (host.reloadPlugins) {
          const report = await host.reloadPlugins(trustTarget);
          const summary = formatPluginReloadReport(report, trustTarget);
          return { message: `${result.message}\n${summary}` };
        }
        if (result.restartRequired) {
          return { message: `${result.message}\n${RESTART_NOTE}` };
        }
      }
      return { message: result.message };
    },
  };
}
