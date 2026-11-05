import {
  createPromptsPlugin,
  createSkillsPlugin,
  createSyncPlugin,
} from '@wrongstack/builtin-plugins';
import type {
  ConfigStore,
  Plugin,
  PluginAPI,
  SkillLoader,
  SlashCommand,
} from '@wrongstack/contracts/types';
import type { WstackPaths } from '@wrongstack/core/utils';

/** What the builtin plugins' commands read: the skill library, the profile paths and config. */
export interface PluginCommandHost {
  skillLoader?: SkillLoader | undefined;
  paths?: WstackPaths | undefined;
  configStore?: ConfigStore | undefined;
  /** Encrypts the sync token before `/sync` stores it. */
  vault?: { encrypt(plaintext: string): string; decrypt?(value: string): string } | undefined;
}

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

/**
 * The slash commands of the builtin plugins that work without a terminal or a running agent
 * loop: the skill library (`/skill-search`, `/skill-import`, `/skill-gen`, …), the prompt
 * library (`/prompts`, `/prompt-gen`, `/perf`, the hunts) and `/sync`. Each plugin is set up
 * against an API that only collects its commands, so none of its tools, hooks or event
 * handlers start in the engine. Cloud config sync (a background timer) and specialist
 * triggers (driven by the agent loop's events) stay with the TUI.
 */
export async function buildPluginCommands(host: PluginCommandHost): Promise<SlashCommand[]> {
  const plugins: Plugin[] = [
    createSkillsPlugin({ skillLoader: host.skillLoader }),
    createPromptsPlugin({ paths: host.paths }),
    createSyncPlugin({
      paths: host.paths,
      configStore: host.configStore,
      ...(host.vault ? { vault: host.vault } : {}),
    }),
  ];
  const commands: SlashCommand[] = [];
  for (const plugin of plugins) {
    const api = {
      config: {
        paths: host.paths,
        configStore: host.configStore,
        skillLoader: host.skillLoader,
      },
      slashCommands: {
        register: (command: SlashCommand) => commands.push(command),
        unregister: () => undefined,
      },
      log: quietLog,
      llm: undefined,
    } as unknown as PluginAPI;
    try {
      await plugin.setup?.(api);
    } catch {
      // A plugin that cannot start here offers no commands; the others still do.
    }
  }
  return commands;
}
