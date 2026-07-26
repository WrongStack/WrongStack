import * as fs from 'node:fs/promises';
import type { Config } from '@wrongstack/core/types';
import { createFallbackManageTools, createPluginManagerTool } from '@wrongstack/core/tools';
import type { ToolRegistry } from '@wrongstack/core/registry';
import { PLUGIN_AUDIT_ENTRIES, runPluginManagementCommand } from '../plugin-management.js';

type ConfigStoreLike = {
  get(): Config;
  update(patch: Partial<Config>): void;
};

export interface RegisterCliManagementToolsDeps {
  toolRegistry: ToolRegistry;
  configStore: ConfigStoreLike;
  profileConfigPath: string;
  stdinInteractive: boolean;
}

export function registerCliManagementTools({
  toolRegistry,
  configStore,
  profileConfigPath,
  stdinInteractive,
}: RegisterCliManagementToolsDeps): void {
  const fallbackManageTools = createFallbackManageTools({
    getConfig: () => configStore.get(),
    updateConfig: async (mutate: (cfg: Record<string, unknown>) => void) => {
      const raw = await fs.readFile(profileConfigPath, 'utf8').catch(() => '{}');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      mutate(parsed);
      await fs.writeFile(profileConfigPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
      configStore.update(parsed as Partial<Config>);
    },
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
