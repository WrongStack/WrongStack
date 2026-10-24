import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  Config,
  Logger,
  ModelsRegistry,
  Provider,
  ProviderConfig,
  SecretVault,
} from '@wrongstack/contracts/types';
import { createFallbackModelExtension, type FallbackProfileManager } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { ProviderRegistry } from '@wrongstack/core/registry';
import {
  type ProviderConfigSnapshot,
  readProviderSnapshot,
  SessionMemoryConsolidator,
  watchProviderConfig,
} from '@wrongstack/core/storage';
import { readJsonObjectFile, type WstackPaths } from '@wrongstack/core/utils';
import { createProxyInstantApply } from '@wrongstack/core/wiring/proxy-rewrite';
import { unavailableProviderCredentials, withCatalogCapabilities } from '@wrongstack/providers';
import { getSageService } from '@wrongstack/sage';
import { ACP_LEADER_PROVIDER_ID } from '../acp-leader/acp-leader-provider.js';
import { WRONGFORGE_AGENT_ID } from '../fleet/wrongforge-client.js';
import { createFallbackGate } from './fallback-gate.js';
import { resolveRawProviderConnection } from './provider-runtime.js';

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
  /** Re-run the canonical layered config loader for file-triggered hot reload. */
  loadConfig: () => Promise<Config>;
  /** Called whenever the live ConfigStore changes, so the caller stays in sync. */
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
  resolveProviderCfgRuntime: (
    config: Config,
    providerId: string,
    opts?: { logger?: { info(message: string): void } | undefined },
  ) => { cfg: ProviderConfig };
  buildProviderForIdRuntime: (
    opts: {
      config: Config;
      providerRegistry: ProviderRegistry;
      logger?: { info(message: string): void } | undefined;
    },
    providerId: string,
  ) => Provider;
  /** Shared provider/model status tracker. */
  statusTracker: ProviderModelStatusTracker;
}

interface ProviderRuntimeResult {
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
  /** Immediately apply the same merged snapshot used by the file watcher. */
  reloadProviderConfig: () => Promise<void>;
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
    loadConfig,
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

  // ── Keep the shared fallback manager on the live config ────────────────
  // The manager owns an immutable snapshot and answers EVERY fallback-chain
  // question (leader, subagents, one-shot). ConfigStore is the single live
  // mutation boundary: every in-process update and full file replacement
  // synchronizes `cfg`, the fallback manager, and the host state here.
  //
  // `configStore.get()` carries credentials (`update` only strips fields the
  // PATCH marks env-sourced, never previously-merged ones), so reloading from
  // it cannot blank out `checkProvider`'s key detection.
  teardownHandlers.push(
    configStore.watch((next: Config) => {
      // Every config mutation — TUI, WebUI, slash command, plugin or file
      // watcher — must update the runtime's canonical snapshot immediately.
      sync(next);
    }),
  );

  // ── Provider config helpers ────────────────────────────────────────────
  // Every provider build logs its WrongProxy rewrite decision (applied/skip
  // reason) so wrongstack.log answers "is traffic proxied?" per build site.
  const resolveProviderCfg = (providerId: string) =>
    resolveProviderCfgRuntime(cfg, providerId, { logger });

  const buildProviderForId = (providerId: string): Provider =>
    buildProviderForIdRuntime({ config: cfg, providerRegistry, logger }, providerId);

  const buildProviderForModel = async (providerId: string, modelId: string): Promise<Provider> => {
    const provider = buildProviderForId(providerId);
    // An ACP agent as the leader has no catalog entry to overlay.
    if (
      !cfg.features.modelsRegistry ||
      providerId === ACP_LEADER_PROVIDER_ID ||
      providerId === WRONGFORGE_AGENT_ID
    )
      return provider;
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
      // `fallbackStickiness` is NOT forwarded here on purpose: the extension
      // reads it from `getConfig()` on every use, so an edit takes effect
      // without a restart. Passing it as a dep would pin the boot-time value.
    }),
  );

  // ── Session-end memory consolidation & curation ─────────────────────────
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
    // Memory curation is now an evidence-bound, read-only background companion
    // on the fleet host. Do not also run the legacy blind afterRun writer.
  }

  // ── Provider/model switch callback ─────────────────────────────────────
  const switchProviderAndModel = async (
    providerId: string,
    modelId: string,
  ): Promise<string | null> =>
    context.runModelTransition(async () => {
      try {
        statusTracker?.unblock(providerId, modelId);
        const nextProvider = await buildProviderForModel(providerId, modelId);
        // ConfigStore notifications synchronously update `cfg` through the
        // subscription above; do not maintain a second mutation path here.
        configStore.update({ provider: providerId, model: modelId });
        const from = context.provider
          ? { providerId: context.provider.id, model: context.model }
          : undefined;
        context.provider = nextProvider;
        context.model = modelId;
        events?.emit('provider.model_switched', {
          sessionId: context.session?.id,
          from,
          to: { providerId, model: modelId },
          timestamp: Date.now(),
        });
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

  // ── WrongProxy instant-apply: rebuild live provider on routing change ──
  // The proxy rewrite is a construction-time decision (`resolveProviderCfg`
  // bakes the URL into the Provider at build). `createProxyInstantApply`
  // subscribes to material proxy-config changes (Settings toggle, probe
  // deactivate/reactivate, proxy URL change) and rebuilds the LIVE provider
  // through the same `buildProviderForModel` path used by /model and the
  // credential hot-reload — so a proxy toggle takes effect immediately
  // instead of on the next incidental provider build.
  const proxyInstantApply = createProxyInstantApply({
    // Prefer the LIVE provider id: fallback hops swap `context.provider`
    // without syncing `cfg.provider`, so reading cfg first would rebuild
    // the configured primary while a fallback model is actually running.
    // `cfg.provider` is only the boot-time fallback (context.provider is
    // not populated until the first provider lands).
    getActiveProviderId: () => context.provider?.id ?? cfg.provider ?? '',
    getRawBaseUrl: (providerId) => resolveRawProviderConnection(cfg, providerId).baseUrl,
    rebuildProvider: async (providerId) => {
      // Serialize against /model + fallback swaps through the same
      // transition gate those paths use, and re-check the live provider
      // inside the gate: a concurrent switch may have moved the session
      // while this rebuild was queued, and a stale rebuild must not
      // overwrite the newer provider (provider/model drift).
      await context.runModelTransition(async () => {
        if (context.provider?.id !== providerId) return; // superseded
        // Same swap shape as the credential hot-reload below: rebuild for
        // the model that is live right now so the capability overlay is kept.
        context.provider = await buildProviderForModel(providerId, String(context.model ?? ''));
      });
    },
    logger,
  });
  teardownHandlers.push(() => proxyInstantApply.dispose());

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
    'fallbackProfile',
    'favoriteModels',
    'disabledModels',
    'disabledProviders',
    'favoriteModelsOnly',
    'modelAvailabilitySchedule',
    'modelMatrix',
    'fallbackAuto',
    'fallbackStickiness',
    'fallbackMaxLastResortCandidates',
    'uiLocale',
  ];

  const activeProfileOf = (c: Config): string =>
    typeof c.activeProfile === 'string' && c.activeProfile ? c.activeProfile : 'default';

  // Exposed to in-process config writers (notably the TUI auth panel). File
  // watching remains the safety net for external editors, while this avoids a
  // debounce-sized window where a just-saved key is absent from the live
  // provider instance.
  let reloadProviderConfig = async (): Promise<void> => {};

  const configWatchEnabled = process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1';
  {
    // Active profile name from the merged config (bootstrap + layers).
    // Re-evaluated whenever the profile changes (see the rebind watcher at the
    // end of this block) — a mid-session profile switch used to leave the
    // watcher pinned to the OLD profile's file, so edits to the profile the
    // user had actually switched to never hot-reloaded.
    let activeProfile = activeProfileOf(cfg);
    // `trusted: false` marks a layer the user does not own. `inProjectConfig`
    // (<project>/.wrongstack/config.json) is repo-committed, so cloning a
    // repository is enough to author it — exactly the boundary
    // `ConfigLoader` draws by running that one file (and only that one)
    // through `stripUnsafeInProjectFields` at boot (config-loader.ts:193).
    // This watcher re-reads the same layers on every config write, so without
    // the same filter the boot-time strip is undone by the first routine save.
    let configLayers: { path: string; priority: number; trusted: boolean }[] = [];
    const rebuildLayers = (): void => {
      configLayers = [
        { path: wpaths.profileConfig(activeProfile), priority: 1, trusted: true },
        { path: wpaths.projectLocalConfig, priority: 2, trusted: true },
        { path: wpaths.inProjectConfig, priority: 3, trusted: false },
      ];
    };
    rebuildLayers();

    /**
     * Drop the credential-bearing slice of a snapshot read from an untrusted
     * layer, keeping the routing fields that layer is allowed to set.
     *
     * `providers`, `apiKey`, `baseUrl` and `fallbackMaxLastResortCandidates`
     * are precisely the snapshot fields that appear in
     * `KNOWN_DENIED_IN_PROJECT`; every other field on
     * `ProviderConfigSnapshot` — uiLocale, the remaining fallback and favorite
     * routing fields, modelMatrix, modelAvailabilitySchedule — is in
     * `IN_PROJECT_ALLOWED_KEYS`, so a repo may still express those.
     * This list must stay in step with that policy: the watcher re-applies
     * these layers on every config write, so anything it forgets to strip
     * undoes the boot-time strip on the first routine save.
     *
     * `snapshotHasProviders` is cleared with them: it exists to tell the merge
     * "a layer really did define providers", and an untrusted layer's claim to
     * that must not survive either. The merge carries the flag forward from
     * lower-priority trusted layers.
     */
    const sanitizeUntrustedSnapshot = (
      snap: ProviderConfigSnapshot,
      path: string,
    ): ProviderConfigSnapshot => {
      // `fallbackMaxLastResortCandidates` rides along because it is in
      // `KNOWN_DENIED_IN_PROJECT`: a repo-committed 0 would silently strip the
      // last-resort failover depth. Every other routing field on the snapshot
      // is in `IN_PROJECT_ALLOWED_KEYS`, so a repo may still express those.
      const { providers, apiKey, baseUrl, fallbackMaxLastResortCandidates, ...rest } = snap;
      const dropped = [
        ...(Object.keys(providers ?? {}).length > 0 ? ['providers'] : []),
        ...(apiKey !== undefined ? ['apiKey'] : []),
        ...(baseUrl !== undefined ? ['baseUrl'] : []),
        ...(fallbackMaxLastResortCandidates !== undefined
          ? ['fallbackMaxLastResortCandidates']
          : []),
      ];
      if (dropped.length > 0) {
        logger.warn(
          `Config watcher: ignored credential field(s) from the repo-committed config ` +
            `"${path}": ${dropped.join(', ')}. Only your profile config may set these.`,
        );
      }
      return { ...rest, providers: {}, snapshotHasProviders: false };
    };

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
        const raw = await readProviderSnapshot(layer.path, vault, (msg: string) =>
          logger.warn(`Config watcher (${layer.path}): ${msg}`),
        );
        if (!raw) continue;
        const snap = layer.trusted ? raw : sanitizeUntrustedSnapshot(raw, layer.path);
        if (!merged) {
          // Deep-clone the first layer's providers to avoid future mutation.
          merged = {
            ...snap,
            providers: { ...snap.providers },
            snapshotHasProviders: snap.snapshotHasProviders,
          };
        } else {
          // Merge higher-priority layer with carry-forward from lower.
          // Driven by ROUTING_FIELDS (plus the two credential fields) rather
          // than a hand-written spread per field: the old form listed each
          // field three times, so every field added to ROUTING_FIELDS without
          // a matching spread was silently dropped from the merge while still
          // being force-cleared by the patch loop below.
          // Assigning only when the value is defined preserves
          // exactOptionalPropertyTypes.
          const next: ProviderConfigSnapshot = {
            providers: { ...merged.providers, ...snap.providers },
            // Carry forward the snapshotHasProviders flag from the higher-priority layer.
            // When a layer has providers, merged knows providers were found somewhere.
            snapshotHasProviders: snap.snapshotHasProviders || merged.snapshotHasProviders,
          };
          const snapRec = snap as unknown as Record<string, unknown>;
          const mergedRec = merged as unknown as Record<string, unknown>;
          const nextRec = next as unknown as Record<string, unknown>;
          for (const key of ['apiKey', 'baseUrl', ...ROUTING_FIELDS] as const) {
            const winner = snapRec[key] ?? mergedRec[key];
            if (winner !== undefined) nextRec[key] = winner;
          }
          merged = next;
        }
      }
      return merged;
    };

    // Shared callback for all watchers: re-read all layers, compute the
    // merged snapshot, and apply it to cfg + ConfigStore.
    let previousSnapshotSerialized: string | undefined;
    let failedReloadId: string | undefined;
    const reloadFromDisk = async (): Promise<void> => {
      // Validate the watched layers leniently first. A torn/corrupt write must
      // not replace the live runtime with defaults while an atomic save settles.
      const merged = await readMergedSnapshot();
      if (!merged) return;

      // Re-run the canonical loader instead of maintaining a second whitelist
      // here. This applies every Config field with the same precedence,
      // validation, env overrides and in-project trust policy as startup.
      const nextConfig = await loadConfig();
      const serialized = serializeProviderRuntimeSnapshot(nextConfig);
      const observedProvider = context.provider;
      const activeId = observedProvider?.id ?? cfg.provider;
      if (serialized === previousSnapshotSerialized && failedReloadId !== activeId) return;
      previousSnapshotSerialized = serialized;

      // Snapshot credential state before replacement so only credential
      // changes rebuild the provider; every other field still reaches all
      // ConfigStore subscribers immediately.
      const before = JSON.stringify(resolveProviderCfg(activeId).cfg);
      const removedAccount =
        Object.hasOwn(cfg.providers ?? {}, activeId) &&
        !Object.hasOwn(nextConfig.providers ?? {}, activeId);

      configStore.replace(nextConfig);
      // Only rebuild the active provider if its credential config changed.
      // Routing-only edits (fallbackProfiles, modelMatrix, etc.) reach
      // ConfigStore above but never need a provider rebuild.
      const after = JSON.stringify(resolveProviderCfg(activeId).cfg);
      if (after === before && failedReloadId !== activeId && !removedAccount) return;
      await context.runModelTransition(async () => {
        // A queued model switch already owns the new live provider.
        if (context.provider !== observedProvider && context.provider?.id !== activeId) return;
        try {
          if (removedAccount) throw new Error('Auth profile was removed');
          context.provider = await buildProviderForModel(activeId, String(context.model ?? ''));
          failedReloadId = undefined;
          logger.info(`Provider credentials reloaded from config (${activeId})`);
        } catch (err) {
          failedReloadId = activeId;
          if (observedProvider) {
            context.provider = unavailableProviderCredentials(
              activeId,
              context.provider?.capabilities ?? observedProvider.capabilities,
            );
          }
          logger.warn(
            `Credential hot-reload failed for ${activeId}: ${(err as Error).message ?? String(err)}`,
          );
        }
      });
    };
    // Serialize the whole read/apply/rebuild operation. Multiple file layers
    // can notify together, and a later credential write must not be applied
    // while an earlier provider build is still awaiting its catalog overlay.
    let reloadChain = Promise.resolve();
    const onAnyConfigChange = (): Promise<void> => {
      const next = reloadChain.then(reloadFromDisk);
      reloadChain = next.catch(() => {});
      return next;
    };
    reloadProviderConfig = onAnyConfigChange;

    // Set up a watcher for EACH config layer. The `watchProviderConfig`
    // watcher provides file-watch, debounce, and no-op guard per path.
    // When any layer fires, `onAnyConfigChange` re-reads and merges all
    // layers, so a change to any file produces a correctly-merged result.
    let watchers: ReturnType<typeof watchProviderConfig>[] = [];
    const openWatchers = (): void => {
      watchers = configLayers.map((layer) =>
        watchProviderConfig(
          layer.path,
          vault,
          () => {
            void onAnyConfigChange();
          },
          { warn: (msg) => logger.warn(`Config watcher (${layer.path}): ${msg}`) },
        ),
      );
      // The root bootstrap (~/.wrongstack/config.json) carries the profile
      // SELECTION, not provider settings, so it cannot join `configLayers`:
      // `readProviderSnapshot` builds its snapshot from an explicit whitelist
      // that drops both `version` and `activeProfile`, and a 4th
      // `{providers:{}, snapshotHasProviders:false}` layer at priority 0 would
      // become the seed snapshot and clobber the providers carry-forward.
      // It gets a dedicated subscription instead — which is also what keeps
      // the ConfigStore `version` guard safe, since `version` never enters a
      // merge here.
      watchers.push(
        watchProviderConfig(
          wpaths.globalConfig,
          vault,
          async () => {
            // Lenient read: a missing or torn bootstrap yields {} and is
            // treated as "no selection change" rather than throwing out of an
            // async watcher callback, where nothing would await it.
            const bootstrap = await readJsonObjectFile(wpaths.globalConfig);
            const selected = bootstrap['activeProfile'];
            const current = configStore.get().activeProfile ?? 'default';
            if (typeof selected !== 'string' || !selected || selected === current) return;
            // The store update is the only event source the rebind watcher
            // below observes; this watcher deliberately knows nothing about
            // layers so there is a single path to a rebind.
            configStore.update({ activeProfile: selected } as Partial<Config>);
          },
          { warn: (msg) => logger.warn(`Config watcher (bootstrap): ${msg}`) },
        ),
      );
    };
    const closeWatchers = (): void => {
      for (const w of watchers) w.close();
      watchers = [];
    };
    if (configWatchEnabled) {
      openWatchers();

      // Re-point the watchers when the session switches profiles. The layer
      // paths are derived from `activeProfile`, which was captured once at
      // wiring time — after a `/profile` switch the runtime kept watching the
      // previous profile's file, so routing edits to the live profile never
      // reloaded (and edits to the abandoned one still did).
      teardownHandlers.push(
        configStore.watch((next: Config) => {
          const nextProfile = activeProfileOf(next);
          if (nextProfile === activeProfile) return;
          activeProfile = nextProfile;
          closeWatchers();
          rebuildLayers();
          openWatchers();
          // The new profile's file may already differ from what is in memory.
          previousSnapshotSerialized = undefined;
          void onAnyConfigChange();
        }),
      );
      teardownHandlers.push(closeWatchers);
    }
  }

  return {
    resolveProviderCfg,
    buildProviderForId,
    buildProviderForModel,
    refreshMaxContextFor,
    refreshRuntimeModelStateFor,
    switchProviderAndModel,
    reloadProviderConfig,
  };
}
