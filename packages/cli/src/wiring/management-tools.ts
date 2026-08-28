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

/** Minimal shape of the models.dev registry this wiring needs. */
type ModelsRegistryLike = {
  getModel(
    providerId: string,
    modelId: string,
  ): Promise<
    | {
        capabilities?: { maxContext?: number | undefined } | undefined;
        cost?:
          | {
              input?: number | undefined;
              output?: number | undefined;
              cache_read?: number | undefined;
              cache_write?: number | undefined;
            }
          | undefined;
      }
    | undefined
  >;
};

/** Minimal event-bus shape: enough to observe context size and turn boundaries. */
type EventsLike = {
  on(event: string, handler: (...args: unknown[]) => void): unknown;
};

interface RegisterCliManagementToolsDeps {
  toolRegistry: ToolRegistry;
  configStore: ConfigStoreLike;
  profileConfigPath: string;
  stdinInteractive: boolean;
  /**
   * Session event bus. Used only to feed `leader_tier_set`'s guard rails: the
   * live context size (`ctx.pct`) and the turn counter behind the dwell window
   * (`iteration.started` with `index === 0` marks a new turn). Without these the
   * economic and context-window guards have nothing to measure and the tool
   * falls back to its structural checks alone.
   */
  events?: EventsLike | undefined;
  /** models.dev registry, for the per-model prices behind the break-even test. */
  modelsRegistry?: ModelsRegistryLike | undefined;
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
  events,
  modelsRegistry,
  getHookRunner,
  getSwitchProviderAndModel,
}: RegisterCliManagementToolsDeps): void {
  // Live inputs for the leader tier guard rails. These are observed rather than
  // asked for, so nothing else in the loop has to know the tier layer exists.
  const tierState: {
    contextTokens: number;
    turns: number;
    currentTier: string | undefined;
    switchedAtTurn: number;
  } = { contextTokens: 0, turns: 0, currentTier: undefined, switchedAtTurn: 0 };

  if (events) {
    events.on('ctx.pct', (...args: unknown[]) => {
      // The bus hands handlers (event, payload); either position may carry the
      // fields depending on the emitter, so read whichever has `tokens`.
      for (const arg of args) {
        const tokens = (arg as { tokens?: unknown } | undefined)?.tokens;
        if (typeof tokens === 'number' && tokens > 0) {
          tierState.contextTokens = tokens;
          return;
        }
      }
    });
    events.on('iteration.started', (...args: unknown[]) => {
      // `index === 0` is the first iteration of a turn, so counting those counts
      // TURNS — not iterations. The dwell window is documented in turns, and a
      // per-iteration counter would let it expire several times inside one long
      // turn, which is exactly the cache thrash the guard exists to prevent.
      for (const arg of args) {
        const index = (arg as { index?: unknown } | undefined)?.index;
        if (index === 0) {
          tierState.turns += 1;
          return;
        }
      }
    });
  }

  const fallbackManageTools = createFallbackManageTools({
    getConfig: () => configStore.get(),
    getCurrentTier: () => tierState.currentTier,
    getContextTokens: () => (tierState.contextTokens > 0 ? tierState.contextTokens : undefined),
    getTurnsSinceTierSwitch: () => tierState.turns - tierState.switchedAtTurn,
    onTierSwitched: (tier: string) => {
      tierState.currentTier = tier;
      tierState.switchedAtTurn = tierState.turns;
    },
    ...(modelsRegistry
      ? {
          getModelEconomics: async (providerId: string, modelId: string) => {
            try {
              const model = await modelsRegistry.getModel(providerId, modelId);
              if (!model) return undefined;
              const cost = model.cost;
              return {
                ...(typeof cost?.input === 'number' ? { inputPerMTok: cost.input } : {}),
                ...(typeof cost?.output === 'number' ? { outputPerMTok: cost.output } : {}),
                ...(typeof cost?.cache_read === 'number'
                  ? { cacheReadPerMTok: cost.cache_read }
                  : {}),
                ...(typeof cost?.cache_write === 'number'
                  ? { cacheWritePerMTok: cost.cache_write }
                  : {}),
                ...(typeof model.capabilities?.maxContext === 'number' &&
                model.capabilities.maxContext > 0
                  ? { maxContext: model.capabilities.maxContext }
                  : {}),
              };
            } catch {
              // A registry miss must not block a tier switch outright — the
              // policy already treats absent pricing as "judge on the
              // structural guards alone".
              return undefined;
            }
          },
        }
      : {}),
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
