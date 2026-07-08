import {
  type Config,
  createFallbackModelExtension,
  type EventBus,
  type Logger,
  type Provider,
  type ProviderConfig,
  type ProviderRegistry,
  type SecretVault,
  SessionMemoryConsolidator,
  type WstackPaths,
  watchProviderConfig,
} from '@wrongstack/core';
import { patchConfig } from '../utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: large dep bag
type AnyObj = any;

export interface ProviderRuntimeDeps {
  config: { current: Config };
  configStore: AnyObj;
  providerRegistry: ProviderRegistry;
  agent: AnyObj;
  memoryStore: AnyObj;
  refreshMaxContext: (providerId: string, modelId: string, cfg?: ProviderConfig) => Promise<void>;
  refreshActiveReasoningConfig: (providerId: string, modelId: string) => Promise<void>;
  wpaths: WstackPaths;
  vault: SecretVault;
  logger: Logger;
  teardownHandlers: (() => void)[];
  context: AnyObj;
  events: EventBus;
  resolveProviderCfgRuntime: (config: Config, providerId: string) => { cfg: ProviderConfig };
  buildProviderForIdRuntime: (opts: { config: Config; providerRegistry: ProviderRegistry }, providerId: string) => Provider;
}

export interface ProviderRuntimeResult {
  resolveProviderCfg: (providerId: string) => { cfg: ProviderConfig };
  buildProviderForId: (providerId: string) => Provider;
  refreshMaxContextFor: (providerId: string, modelId: string) => Promise<void>;
  refreshRuntimeModelStateFor: (providerId: string, modelId: string) => Promise<void>;
  switchProviderAndModel: (providerId: string, modelId: string) => Promise<string | null>;
}

/**
 * Wire runtime provider-config helpers, fallback model extension,
 * memory consolidation, the provider/model switch callback, and
 * the credential hot-reload watcher.
 */
export function setupProviderRuntime(deps: ProviderRuntimeDeps): ProviderRuntimeResult {
  const {
    config,
    configStore,
    providerRegistry,
    agent,
    memoryStore,
    refreshMaxContext,
    refreshActiveReasoningConfig,
    wpaths,
    vault,
    logger,
    teardownHandlers,
    context,
    events,
    resolveProviderCfgRuntime,
    buildProviderForIdRuntime,
  } = deps;

  // ── Provider config helpers ────────────────────────────────────────────
  const cfgRef = config;
  const resolveProviderCfg = (providerId: string) =>
    resolveProviderCfgRuntime(cfgRef.current, providerId);

  const buildProviderForId = (providerId: string): Provider =>
    buildProviderForIdRuntime({ config: cfgRef.current, providerRegistry }, providerId);

  const refreshMaxContextFor = async (
    providerId: string,
    modelId: string,
  ): Promise<void> => {
    const { cfg } = resolveProviderCfg(providerId);
    await refreshMaxContext(providerId, modelId, cfg);
  };

  const refreshRuntimeModelStateFor = async (
    providerId: string,
    modelId: string,
  ): Promise<void> => {
    await refreshMaxContextFor(providerId, modelId);
    await refreshActiveReasoningConfig(providerId, modelId);
  };

  // ── Fallback extension ─────────────────────────────────────────────────
  agent.extensions.register(
    createFallbackModelExtension({
      getConfig: () => cfgRef.current,
      buildProvider: buildProviderForId,
      onModelSwitch: refreshRuntimeModelStateFor,
      events,
      logger,
    }),
  );

  // ── Session-end memory consolidation ───────────────────────────────────
  if (cfgRef.current.features.memory && cfgRef.current.features.memoryConsolidation !== false) {
    agent.extensions.register(
      new SessionMemoryConsolidator({
        memoryStore,
      }),
    );
  }

  // ── Provider/model switch callback ─────────────────────────────────────
  const switchProviderAndModel = async (
    providerId: string,
    modelId: string,
  ): Promise<string | null> => {
    try {
      context.provider = buildProviderForId(providerId);
      context.model = modelId;
      cfgRef.current = patchConfig(cfgRef.current, { provider: providerId, model: modelId });
      configStore.update({ provider: providerId, model: modelId });
      await refreshMaxContextFor(providerId, modelId);
      await refreshActiveReasoningConfig(providerId, modelId);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // ── Credential hot-reload watcher ──────────────────────────────────────
  if (process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    const credentialWatcher = watchProviderConfig(
      wpaths.globalConfig,
      vault,
      (snapshot: AnyObj) => {
        const activeId = cfgRef.current.provider;
        const before = JSON.stringify(resolveProviderCfg(activeId).cfg);
        cfgRef.current = patchConfig(cfgRef.current, {
          providers: snapshot.providers,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
        });
        configStore.update({
          providers: snapshot.providers,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
        });
        const after = JSON.stringify(resolveProviderCfg(activeId).cfg);
        if (after === before) return;
        try {
          context.provider = buildProviderForId(activeId);
          logger.info(`Provider credentials reloaded from config.json (${activeId})`);
        } catch (err) {
          logger.warn(`Credential hot-reload failed for ${activeId}: ${(err as Error).message ?? String(err)}`);
        }
      },
      { warn: (msg) => logger.warn(`Config watcher: ${msg}`) },
    );
    teardownHandlers.push(() => credentialWatcher.close());
  }

  return {
    resolveProviderCfg,
    buildProviderForId,
    refreshMaxContextFor,
    refreshRuntimeModelStateFor,
    switchProviderAndModel,
  };
}
