import type { ToolRegistry } from '@wrongstack/core/registry';
import {
  createFallbackManageTools,
  createPluginManagerTool,
  type PluginManagerHookRunner,
} from '@wrongstack/core/tools';
import type { Config } from '@wrongstack/core/types';
import { updateJsonObjectFile } from '@wrongstack/core/utils';
import { PLUGIN_AUDIT_ENTRIES, runPluginManagementCommand } from '../plugin-management.js';

type ConfigStoreLike = {
  get(): Config;
  update(patch: Partial<Config>): void;
};

interface RegisterCliManagementToolsDeps {
  toolRegistry: ToolRegistry;
  configStore: ConfigStoreLike;
  profileConfigPath: string;
  stdinInteractive: boolean;
  /**
   * Late-bound PreToolUse pipeline for plugin_manager's nested `use` path.
   * The hook runner is created by `setupLifecycleAndPlugins` AFTER the
   * management tools register, so cli-main passes a ref-backed getter that
   * starts null and is filled once wiring completes.
   */
  getHookRunner?: (() => PluginManagerHookRunner | null) | undefined;
  /**
   * Late-bound live provider/model switch for leader_model_set. Like the hook
   * runner, cli-main creates switchProviderAndModel AFTER the management tools
   * register (it needs the provider runtime), so it passes a ref-backed getter
   * that starts null and is filled once provider wiring completes.
   */
  getSwitchProviderAndModel?:
    | (() => ((providerId: string, modelId: string) => Promise<string | null>) | null)
    | undefined;
}

export function registerCliManagementTools({
  toolRegistry,
  configStore,
  profileConfigPath,
  stdinInteractive,
  getHookRunner,
  getSwitchProviderAndModel,
}: RegisterCliManagementToolsDeps): void {
  const fallbackManageTools = createFallbackManageTools({
    getConfig: () => configStore.get(),
    // updateJsonObjectFile is the same atomic read-mutate-write helper
    // mcp_control uses on this very file — the previous bare
    // readFile→JSON.parse→writeFile raced it and could drop concurrent
    // updates (and tore the file on a crash mid-write).
    updateConfig: async (mutate: (cfg: Record<string, unknown>) => void) => {
      const next = await updateJsonObjectFile(profileConfigPath, (cfg) => {
        mutate(cfg);
      });
      configStore.update(next as Partial<Config>);
    },
    ...(getSwitchProviderAndModel
      ? {
          switchProviderAndModel: async (
            providerId: string,
            modelId: string,
          ): Promise<string | null> => {
            const switchFn = getSwitchProviderAndModel();
            if (!switchFn) {
              return 'the live model switch is not ready yet (still booting) — try again shortly';
            }
            return switchFn(providerId, modelId);
          },
        }
      : {}),
    // Interactive key entry for REPL mode reads a line from stdin without echo.
    ...(stdinInteractive
      ? {
          requestInput: async (prompt: string): Promise<string> => {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            return new Promise<string>((resolve) => {
              rl.question(`\n${prompt}\n> `, (answer) => {
                rl.close();
                resolve(answer);
              });
            });
          },
        }
      : {}),
  });
  for (const tool of fallbackManageTools) toolRegistry.register(tool);

  toolRegistry.register(
    createPluginManagerTool({
      ...(getHookRunner ? { getHookRunner } : {}),
      getConfig: () => configStore.get(),
      catalog: PLUGIN_AUDIT_ENTRIES.map((entry) => {
        const aliases = [
          ...(entry.name.startsWith('@wrongstack/') ? [] : [`@wrongstack/plugins/${entry.name}`]),
          ...(entry.name === '@wrongstack/plug-lsp' ? ['lsp'] : []),
          ...(entry.name === 'telegram' ? ['@wrongstack/telegram'] : []),
        ];
        return {
          name: entry.name,
          description: entry.summary,
          risk: entry.risk,
          defaultState: entry.defaultState,
          canDisable: entry.canDisable,
          ...(aliases.length > 0 ? { aliases } : {}),
        };
      }),
      toolRegistry,
      setEnabled: async (plugin, enabled) => {
        const result = await runPluginManagementCommand([enabled ? 'enable' : 'disable', plugin], {
          config: configStore.get(),
          configPath: profileConfigPath,
        });
        if (result.patch) {
          configStore.update(result.patch as unknown as Partial<Config>);
        }
        return {
          ok: result.code === 0,
          message: result.message,
          restartRequired: result.restartRequired === true,
        };
      },
    }),
  );
}
