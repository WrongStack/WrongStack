import { createFallbackModelExtension, type FallbackProfileManager } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { ProviderRegistry } from '@wrongstack/core/registry';
import {
  type ProviderConfigSnapshot,
  readProviderSnapshot,
  SessionMemoryConsolidator,
  watchProviderConfig,
} from '@wrongstack/core/storage';
import type {
  Config,
  Logger,
  ModelsRegistry,
  Provider,
  ProviderConfig,
  SecretVault,
} from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { withCatalogCapabilities } from '@wrongstack/providers';
import { getSageService } from '@wrongstack/sage';
import { createFallbackGate } from './fallback-gate.js';
import { patchConfig } from '../utils.js';

export function serializeProviderRuntimeSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: large dep bag
type AnyObj = any;

export interface ProviderRuntimeDeps {
  config: Config;
  /** Called whenever the function patches config, so the caller stays in sync. */
  onConfigUpdate: (config: Config) => void;
  configStore: AnyObj;
  /** Shared live fallback profile manager from the runtime container. */
  fallbackProfileManager: FallbackProfileManager;
  providerRegistry: ProviderRegistry;
  /**
   * Catalog used to re-resolve per-model capabilities whenever the runtime
   * rebuilds the provider. Without it a rebuilt provider carries only the wire
   * family baseline, where `maxOutput` is undefined.
   */
  modelsRegistry: ModelsRegistry;
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
  buildProviderForIdRuntime: (
    opts: { config: Config; providerRegistry: ProviderRegistry },
    providerId: string,
  ) => Provider;
  /** Shared provider/model status tracker. */
  statusTracker: ProviderModelStatusTracker;
}

export interface ProviderRuntimeResult {
  resolveProviderCfg: (providerId: string) => { cfg: ProviderConfig };
  buildProviderForId: (providerId: string) => Provider;
  /**
   * `buildProviderForId` plus the catalog capability overlay for `modelId`.
   * Use this on every path that swaps `context.provider`, so readers of
   * `provider.capabilities` (`/context`, the compaction denominator) describe
   * the model that is actually about to run.
   */
  buildProviderForModel: (providerId: string, modelId: string) => Promise<Provider>;
  refreshMaxContextFor: (providerId: string, modelId: string) => Promise<void>;
  refreshRuntimeModelStateFor: (providerId: string, modelId: string) => Promise<void>;
  switchProviderAndModel: (providerId: string, modelId: string) => Promise<string | null>;
}

/**
 * Wire runtime provider-config helpers, fallback model extension,
 * memory consolidation, the provider/model switch callback, and
 * the credential hot-reload watcher.
 *
 * Uses `onConfigUpdate` to propagate config patches back to the caller,
 * avoiding the desync that a bare `{ current: Config }` ref would cause
 * when the caller also mutates `config` directly.
 */
export function setupProviderRuntime(deps: ProviderRuntimeDeps): ProviderRuntimeResult {
  const {
    config: initialConfig,
    onConfigUpdate,
    configStore,
    fallbackProfileManager,
    providerRegistry,
    modelsRegistry,
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
    statusTracker,
  } = deps;

  // Local mutable config — seeded from deps, kept in sync via onConfigUpdate.
  let cfg = initialConfig;
  const sync = (next: Config): void => {
    cfg = next;
    fallbackProfileManager.reload(next);
    onConfigUpdate(next);
  };

  // ── Provider config helpers ────────────────────────────────────────────
  const resolveProviderCfg = (providerId: string) => resolveProviderCfgRuntime(cfg, providerId);

  const buildProviderForId = (providerId: string): Provider =>
    buildProviderForIdRuntime({ config: cfg, providerRegistry }, providerId);

  const buildProviderForModel = async (providerId: string, modelId: string): Promise<Provider> => {
    const provider = buildProviderForId(providerId);
    if (!cfg.features.modelsRegistry) return provider;
    const { cfg: resolvedCfg } = resolveProviderCfg(providerId);
    // `withCatalogCapabilities` swallows its own failures — an unreachable
    // catalog leaves the family baseline in place rather than blocking the
    // switch.
    return withCatalogCapabilities(
      modelsRegistry,
      providerId,
      provider,
      { ...resolvedCfg, type: providerId, model: modelId },
      logger,
    );
  };

  const refreshMaxContextFor = async (providerId: string, modelId: string): Promise<void> => {
    const { cfg: resolvedCfg } = resolveProviderCfg(providerId);
    await refreshMaxContext(providerId, modelId, resolvedCfg);
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
      getConfig: () => cfg,
      fallbackProfileManager,
      // The fallback chain hops between models; each hop needs its own
      // model's capabilities, not the ones the session booted with.
      buildProvider: (providerId, modelId) =>
        modelId ? buildProviderForModel(providerId, modelId) : buildProviderForId(providerId),
      onModelSwitch: refreshRuntimeModelStateFor,
      events,
      logger,
      statusTracker,
      // Fallback gate — shows a modal with countdown + manual pick in every
      // UI surface (TUI/WebUI/SimpleUI) before switching models. The gate
      // emits provider.fallback_pending and waits for provider.fallback_choice
      // or the auto-switch countdown.
      fallbackGate: createFallbackGate(events),
      fallbackGateSeconds: 7,
      ...(cfg.fallbackStickiness?.primaryProbeInterval !== undefined
        ? { primaryCooldownMs: cfg.fallbackStickiness.primaryProbeInterval }
        : {}),
      ...(cfg.fallbackStickiness?.stickyFallbackTurns !== undefined
        ? { stickyFallbackTurns: cfg.fallbackStickiness.stickyFallbackTurns }
        : {}),
    }),
  );

  // ── Session-end memory consolidation ───────────────────────────────────
  if (cfg.features.memory && cfg.features.memoryConsolidation !== false) {
    const consSage = getSageService(memoryStore) as
      | import('@wrongstack/core/storage').ConsolidatorSage
      | undefined;
    agent.extensions.register(
      new SessionMemoryConsolidator({
        memoryStore,
        ...(consSage ? { Sage: consSage } : {}),
      }),
    );
  }

  // ── Provider/model switch callback ─────────────────────────────────────
  const switchProviderAndModel = async (
    providerId: string,
    modelId: string,
  ): Promise<string | null> =>
    context.runModelTransition(async () => {
      try {
        const nextProvider = await buildProviderForModel(providerId, modelId);
        configStore.update({ provider: providerId, model: modelId });
        sync(patchConfig(cfg, { provider: providerId, model: modelId }));
        context.provider = nextProvider;
        context.model = modelId;
        await Promise.all([
          refreshMaxContextFor(providerId, modelId),
          refreshActiveReasoningConfig(providerId, modelId),
        ]).catch((err) => {
          logger.warn(
            `Provider/model switched, but runtime capability refresh failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    });

  // ── Multi-layer credential + routing hot-reload watcher ──────────────
  // Previously watched only `wpaths.globalConfig` and applied its raw values
  // to the already-merged config, which:
  //   1. Missed changes to higher-precedence project-local and in-project
  //      config files (project-scope hot-reload gap).
  //   2. Overwrote project-local routing overrides with global values
  //      (config-precedence regression).
  //   3. Left deleted routing fields active in memory because optional
  //      fields were patched only when defined (stale deleted settings).
  //
  // Watch the active profile and project layers. The root config is bootstrap
  // metadata only and must never participate in credential/routing reloads.
  // The merged result is then applied atomically, so deletions (absent
  // fields) correctly restore the lower-precedence or default value.
  const ROUTING_FIELDS: (keyof ProviderConfigSnapshot)[] = [
    'fallbackModels',
    'fallbackBridge',
    'fallbackProfiles',
    'favoriteModels',
    'favoriteModelsOnly',
    'modelAvailabilitySchedule',
    'modelMatrix',
    'fallbackAuto',
    'uiLocale',
  ];

  if (process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    // Active profile name from the merged config (bootstrap + layers).
    const activeProfile =
      typeof cfg.activeProfile === 'string' && cfg.activeProfile ? cfg.activeProfile : 'default';
    const configLayers: { path: string; priority: number }[] = [
      { path: wpaths.profileConfig(activeProfile), priority: 1 },
      { path: wpaths.projectLocalConfig, priority: 2 },
      { path: wpaths.inProjectConfig, priority: 3 },
    ];

    /**
     * Re-read ALL config layers and merge their credential/routing fields
     * with correct precedence. Higher-priority layers override lower ones.
     * Uses conditional spread so no `undefined` values reach the returned
     * snapshot object (exactOptionalPropertyTypes compatibility).
     */
    const readMergedSnapshot = async (): Promise<ProviderConfigSnapshot | undefined> => {
      let merged: ProviderConfigSnapshot | undefined;
      // Read layers in priority order so each higher layer overrides the last.
      for (const layer of configLayers.sort((a, b) => a.priority - b.priority)) {
        const snap = await readProviderSnapshot(layer.path, vault, (msg: string) =>
          logger.warn(`Config watcher (${layer.path}): ${msg}`),
        );
        if (!snap) continue;
        if (!merged) {
          // Deep-clone the first layer's providers to avoid future mutation.
          merged = {
            ...snap,
            providers: { ...snap.providers },
            snapshotHasProviders: snap.snapshotHasProviders,
          };
        } else {
          // Merge higher-priority layer with carry-forward from lower.
          // Spread-with-condition avoids `undefined` values that violate
          // exactOptionalPropertyTypes.
          merged = {
            providers: { ...merged.providers, ...snap.providers },
            ...(snap.apiKey !== undefined
              ? { apiKey: snap.apiKey }
              : merged.apiKey !== undefined
                ? { apiKey: merged.apiKey }
                : {}),
            ...(snap.baseUrl !== undefined
              ? { baseUrl: snap.baseUrl }
              : merged.baseUrl !== undefined
                ? { baseUrl: merged.baseUrl }
                : {}),
            ...(snap.fallbackModels !== undefined
              ? { fallbackModels: snap.fallbackModels }
              : merged.fallbackModels !== undefined
                ? { fallbackModels: merged.fallbackModels }
                : {}),
            ...(snap.fallbackBridge !== undefined
              ? { fallbackBridge: snap.fallbackBridge }
              : merged.fallbackBridge !== undefined
                ? { fallbackBridge: merged.fallbackBridge }
                : {}),
            ...(snap.fallbackProfiles !== undefined
              ? { fallbackProfiles: snap.fallbackProfiles }
              : merged.fallbackProfiles !== undefined
                ? { fallbackProfiles: merged.fallbackProfiles }
                : {}),
            ...(snap.favoriteModels !== undefined
              ? { favoriteModels: snap.favoriteModels }
              : merged.favoriteModels !== undefined
                ? { favoriteModels: merged.favoriteModels }
                : {}),
            ...(snap.favoriteModelsOnly !== undefined
              ? { favoriteModelsOnly: snap.favoriteModelsOnly }
              : merged.favoriteModelsOnly !== undefined
                ? { favoriteModelsOnly: merged.favoriteModelsOnly }
                : {}),
            ...(snap.modelAvailabilitySchedule !== undefined
              ? { modelAvailabilitySchedule: snap.modelAvailabilitySchedule }
              : merged.modelAvailabilitySchedule !== undefined
                ? { modelAvailabilitySchedule: merged.modelAvailabilitySchedule }
                : {}),
            ...(snap.modelMatrix !== undefined
              ? { modelMatrix: snap.modelMatrix }
              : merged.modelMatrix !== undefined
                ? { modelMatrix: merged.modelMatrix }
                : {}),
            ...(snap.fallbackAuto !== undefined
              ? { fallbackAuto: snap.fallbackAuto }
              : merged.fallbackAuto !== undefined
                ? { fallbackAuto: merged.fallbackAuto }
                : {}),
            ...(snap.uiLocale !== undefined
              ? { uiLocale: snap.uiLocale }
              : merged.uiLocale !== undefined
                ? { uiLocale: merged.uiLocale }
                : {}),
            // Carry forward the snapshotHasProviders flag from the higher-priority layer.
            // When a layer has providers, merged knows providers were found somewhere.
            snapshotHasProviders: snap.snapshotHasProviders || merged.snapshotHasProviders,
          };
        }
      }
      return merged;
    };

    // Shared callback for all watchers: re-read all layers, compute the
    // merged snapshot, and apply it to cfg + ConfigStore.
    let previousSnapshotSerialized: string | undefined;
    const onAnyConfigChange = async (): Promise<void> => {
      const merged = await readMergedSnapshot();
      if (!merged) return;
      // An array replacer filters nested provider ids and credential fields,
      // making distinct configs serialize as the same `{ providers: {} }`.
      const serialized = serializeProviderRuntimeSnapshot(merged);
      if (serialized === previousSnapshotSerialized) return; // No change
      previousSnapshotSerialized = serialized;

      const activeId = cfg.provider;

      // Build the full patch from the merged snapshot.
      // CREDENTIALS: only propagate when present (they come from the vault).
      // ROUTING FIELDS: ALWAYS propagate, using null when absent from every
      // layer, so deleted fields are explicitly cleared in ConfigStore rather
      // than preserved from the previous state (fixes stale-deleted-settings).
      const mergedPatch: Record<string, unknown> = {
        providers: merged.providers,
      };
      if (merged.apiKey !== undefined) mergedPatch.apiKey = merged.apiKey;
      if (merged.baseUrl !== undefined) mergedPatch.baseUrl = merged.baseUrl;
      for (const key of ROUTING_FIELDS) {
        mergedPatch[key] = (merged as unknown as Record<string, unknown>)[key] ?? null;
      }

      // Snapshot credential state before applying, so we can detect
      // credential-only changes below (routing-only edits skip provider rebuild).
      const before = JSON.stringify(resolveProviderCfg(activeId).cfg);

      // Apply the merged patch to both cfg and ConfigStore.
      sync(patchConfig(cfg, mergedPatch));
      configStore.update(mergedPatch);

      // Only rebuild the active provider if its credential config changed.
      // Routing-only edits (fallbackProfiles, modelMatrix, etc.) reach
      // ConfigStore above but never need a provider rebuild.
      const after = JSON.stringify(resolveProviderCfg(activeId).cfg);
      if (after === before) return;
      try {
        // Rebuild for the model that is live right now — a credential reload
        // must not silently drop the active model's capability overlay.
        context.provider = await buildProviderForModel(activeId, String(context.model ?? ''));
        logger.info(`Provider credentials reloaded from config (${activeId})`);
      } catch (err) {
        logger.warn(
          `Credential hot-reload failed for ${activeId}: ${(err as Error).message ?? String(err)}`,
        );
      }
    };

    // Set up a watcher for EACH config layer. The `watchProviderConfig`
    // watcher provides file-watch, debounce, and no-op guard per path.
    // When any layer fires, `onAnyConfigChange` re-reads and merges all
    // layers, so a change to any file produces a correctly-merged result.
    const watchers = configLayers.map((layer) => {
      const w = watchProviderConfig(
        layer.path,
        vault,
        () => {
          void onAnyConfigChange();
        },
        { warn: (msg) => logger.warn(`Config watcher (${layer.path}): ${msg}`) },
      );
      return w;
    });
    teardownHandlers.push(() => {
      for (const w of watchers) w.close();
    });
  }

  return {
    resolveProviderCfg,
    buildProviderForId,
    buildProviderForModel,
    refreshMaxContextFor,
    refreshRuntimeModelStateFor,
    switchProviderAndModel,
  };
}
