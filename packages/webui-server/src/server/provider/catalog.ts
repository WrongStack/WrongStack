import type { ModelsRegistry, ProviderConfig } from '@wrongstack/contracts/types';
import {
  type FallbackSuggestCandidate,
  hasProviderCredential,
  isModelRefListed,
  resolveProviderModelList,
} from '@wrongstack/core/models';
import type { WebSocket } from 'ws';
import {
  configuredModelReasoning,
  resolveProviderCatalogForModels,
  resolveProviderModelMetadata,
  SIBLING_CATALOG,
} from '../model-catalog.js';
import { searchCatalogModels } from '../model-catalog-search.js';
import { errMessage } from '../ws-utils.js';
import { hostProviderModels, withHostProviders } from './host-providers.js';
import type { ProviderServiceContext } from './mutations.js';
import { probeModelDescriptors, projectSavedProviders } from './projection.js';

/**
 * One provider's model list exactly as the WebUI picker sees it: saved
 * allowlist + catalog (+ sibling catalog), probed from `{baseUrl}/models`
 * when both are empty, enriched with catalog price/limits/capabilities.
 * Shared by `provider.models` and the fallback suggestion engine so the two
 * can never disagree about what the user can reach.
 */
async function resolveEnrichedModels(
  modelsRegistry: ModelsRegistry,
  providerId: string,
  config: ProviderConfig | undefined,
) {
  const provider = await resolveProviderCatalogForModels(modelsRegistry, providerId, config);
  const active =
    config?.apiKeys?.find((key) => key.label === config.activeKey) ?? config?.apiKeys?.[0];
  const accountOwned = active?.authMethod === 'oauth';
  const siblingCatalogKey = config?.family ?? providerId;
  // Own-key read: `providerId` arrives from a client frame, so an inherited
  // Object member (`toString`, `constructor`, `valueOf`) must not read as a
  // catalog alias — a bare bracket lookup returns the prototype value, which
  // the line below then hands to `modelsRegistry.getProvider()` as a provider
  // id. Same rule `handleProviderModels` applies to the host gate, and the
  // `Object.hasOwn` convention used for every other untrusted key.
  const siblingId = Object.hasOwn(SIBLING_CATALOG, siblingCatalogKey)
    ? SIBLING_CATALOG[siblingCatalogKey]
    : undefined;
  const sibling =
    siblingId && siblingId !== providerId
      ? await modelsRegistry.getProvider(siblingId).catch(() => undefined)
      : undefined;
  let models = resolveProviderModelList(
    config?.models,
    provider,
    config?.type ?? providerId,
    sibling,
    accountOwned,
  );
  if (!accountOwned && models.length === 0 && config?.baseUrl)
    models = await probeModelDescriptors(config);
  // Reasoning-effort vocabulary straight from the in-memory catalog
  // objects (already normalized by the registry — no extra lookups).
  // Sibling-catalog models (e.g. openai ids listed for openai-codex) are
  // mapped from their own catalog so the levels travel with the model.
  const reasoningByModelId = new Map(
    [...(provider?.models ?? []), ...(sibling && sibling !== provider ? sibling.models : [])].map(
      (m) => [m.id, m.reasoningConfig],
    ),
  );
  const enriched = await Promise.all(
    models.map(async (model) => {
      const rc = configuredModelReasoning(config, model.id, reasoningByModelId.get(model.id));
      const reasoningEffortLevels =
        rc?.effortSupported && rc.effortLevels?.length ? [...rc.effortLevels] : undefined;
      // Tri-state companion to the levels: undefined = undocumented, false
      // = the model documents that it has no effort control.
      const effortSupported = rc?.effortSupported;
      // What the catalog documents about switching reasoning off and keeping it between turns;
      // absent when the model's reasoning policy is unknown (no control is then offered).
      const reasoningControls = rc
        ? {
            default: rc.default,
            disableSupported: rc.disableSupported,
            preserveThinking: rc.preserveThinking,
          }
        : undefined;
      if (model.contextWindow && model.capabilities.length > 0) {
        return reasoningEffortLevels || effortSupported !== undefined || reasoningControls
          ? { ...model, reasoningEffortLevels, effortSupported, reasoningControls }
          : model;
      }
      const resolved = await resolveProviderModelMetadata(
        modelsRegistry,
        providerId,
        model.id,
        config,
      ).catch(() => undefined);
      if (!resolved) {
        return reasoningEffortLevels || effortSupported !== undefined || reasoningControls
          ? { ...model, reasoningEffortLevels, effortSupported, reasoningControls }
          : model;
      }
      const capabilities = new Set(model.capabilities);
      if (resolved.capabilities.tools) capabilities.add('tools');
      if (resolved.capabilities.reasoning) capabilities.add('reasoning');
      if (resolved.capabilities.vision) capabilities.add('vision');
      return {
        ...model,
        contextWindow: model.contextWindow ?? resolved.capabilities.maxContext ?? undefined,
        maxOutput: model.maxOutput ?? resolved.capabilities.maxOutput,
        inputCost: model.inputCost ?? resolved.cost?.input,
        outputCost: model.outputCost ?? resolved.cost?.output,
        capabilities: [...capabilities],
        ...(reasoningEffortLevels ? { reasoningEffortLevels } : {}),
        ...(effortSupported !== undefined ? { effortSupported } : {}),
        ...(reasoningControls ? { reasoningControls } : {}),
      };
    }),
  );
  return enriched;
}

/**
 * Catalog + model-resolution surface (6B-2). Moved verbatim from
 * provider-handlers.ts: list/saved/search/models handlers plus the
 * default-provider adoption flow.
 */
export function createCatalogHandlers(ctx: ProviderServiceContext) {
  // Same ref grammar as the WebUI pickers (`provider/model`, `provider model`,
  // bare `model`) — a looser server-side match let `provider model` entries
  // through here while every picker hid them.
  const isDisabled = (providerId: string, modelId: string): boolean => {
    // A disabled provider hides every one of its models — checked first so the
    // per-model scan is skipped entirely for a parked provider.
    const offProvider = providerId.trim().toLowerCase();
    if (
      (ctx.deps.getDisabledProviders?.() ?? []).some(
        (id) => id.trim().toLowerCase() === offProvider,
      )
    ) {
      return true;
    }
    return isModelRefListed(providerId, modelId, ctx.deps.getDisabledModels?.());
  };
  async function handleProvidersList(ws: WebSocket): Promise<void> {
    const { deps, sendMessage, sendOperationResult } = ctx;
    if (!deps.modelsRegistry) {
      sendOperationResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const providers = await deps.modelsRegistry.listProviders();
      // `savedIds.has(id)` used to stand in for "has a key". It means "appears
      // in the saved config at all", so a provider saved with only a `baseUrl`
      // reported `hasApiKey: true` and the panel offered it as ready to use.
      // Same rule as the CLI picker and `/modelcaps` now — see
      // `core/src/models/provider-credentials.ts`.
      const savedProviders = await ctx.loadConfigProviders();
      sendMessage(ws, {
        type: 'provider.catalog',
        payload: {
          providers: providers.map((provider) => ({
            id: provider.id,
            name: provider.name,
            family: provider.family,
            apiBase: provider.apiBase,
            envVars: provider.envVars,
            modelCount: provider.models.length,
            hasApiKey: hasProviderCredential(provider, { providers: savedProviders }),
          })),
        },
      });
    } catch (error) {
      sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function handleProvidersSaved(ws: WebSocket): Promise<void> {
    try {
      ctx.sendMessage(ws, {
        type: 'providers.saved',
        payload: {
          providers: withHostProviders(
            projectSavedProviders(await ctx.loadConfigProviders()),
            ctx.deps.hostProviders?.(),
          ),
        },
      });
    } catch (error) {
      ctx.sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function handleProviderModelsSearch(
    ws: WebSocket,
    query: string,
    limit?: number | undefined,
  ): Promise<void> {
    if (!ctx.deps.modelsRegistry) {
      ctx.sendOperationResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const matches = await searchCatalogModels(ctx.deps.modelsRegistry, query, limit);
      ctx.sendMessage(ws, {
        type: 'provider.models.search_result',
        payload: { query, matches },
      });
    } catch (error) {
      ctx.sendOperationResult(ws, false, errMessage(error));
    }
  }

  async function handleProviderModels(
    ws: WebSocket,
    providerId: string,
    options: { includeDisabled?: boolean | undefined } = {},
  ): Promise<void> {
    // A host provider must never shadow a saved record of the same id — the
    // rule `withHostProviders` applies to the `providers.saved` frame. Consult
    // the host only when nothing is saved under this id; otherwise the two
    // frames disagree about one provider: the list shows the user's saved
    // record while `provider.models` answers with the host's ACP agents, so the
    // picker offers models that belong to a different provider than the row it
    // came from. `Object.hasOwn`, not a bracket truthiness check: `providerId`
    // is client-supplied and an Object.prototype key (`constructor`, `toString`)
    // would otherwise read as a saved record and wrongly suppress the host.
    try {
      const savedProviders = await ctx.loadConfigProviders();
      const hosted = Object.hasOwn(savedProviders, providerId)
        ? undefined
        : hostProviderModels(ctx.deps.hostProviders?.(), providerId);
      if (hosted) {
        ctx.sendMessage(ws, {
          type: 'provider.models',
          payload: {
            provider: providerId,
            models: options.includeDisabled
              ? hosted
              : hosted.filter((model) => !isDisabled(providerId, model.id)),
          },
        });
        return;
      }
      if (!ctx.deps.modelsRegistry) {
        ctx.sendOperationResult(ws, false, 'Models registry not available');
        return;
      }
      const enriched = await resolveEnrichedModels(
        ctx.deps.modelsRegistry,
        providerId,
        savedProviders[providerId],
      );
      ctx.sendMessage(ws, {
        type: 'provider.models',
        payload: {
          provider: providerId,
          models: options.includeDisabled
            ? enriched
            : enriched.filter((model) => !isDisabled(providerId, model.id)),
        },
      });
    } catch (error) {
      ctx.sendOperationResult(ws, false, errMessage(error));
    }
  }

  /**
   * Every model of every SAVED provider, minus the user's disabled models —
   * the only pool fallback suggestions may draw from. A provider whose
   * catalog cannot be resolved is skipped, never fatal.
   */
  async function collectFallbackCandidates(): Promise<FallbackSuggestCandidate[]> {
    const registry = ctx.deps.modelsRegistry;
    if (!registry) return [];
    const saved = await ctx.loadConfigProviders();
    const perProvider = await Promise.all(
      Object.entries(saved).map(async ([providerId, config]) => {
        const models = await resolveEnrichedModels(registry, providerId, config).catch(() => []);
        return models
          .filter((model) => !isDisabled(providerId, model.id))
          .map(
            (model): FallbackSuggestCandidate => ({
              provider: providerId,
              model: model.id,
              name: model.name,
              releaseDate: model.releaseDate,
              contextWindow: model.contextWindow,
              maxOutput: model.maxOutput,
              inputCost: model.inputCost,
              outputCost: model.outputCost,
              capabilities: model.capabilities,
              status: model.status,
              family: model.family,
            }),
          );
      }),
    );
    return perProvider.flat();
  }

  async function adoptDefaultProviderIfUnset(providerId: string): Promise<void> {
    const { deps } = ctx;
    if (!deps.applyModelSwitch || deps.hasActiveModel?.()) return;
    const saved = await ctx.loadConfigProviders();
    await deps.onProvidersLoaded?.(saved);
    const config = saved[providerId];
    if (!config) return;
    let model = config.models?.[0];
    if (!model && deps.modelsRegistry) {
      const catalogId = config.type && config.type !== providerId ? config.type : providerId;
      const catalog = await deps.modelsRegistry.getProvider(catalogId).catch(() => undefined);
      model = catalog?.models?.[0]?.id;
    }
    if (!model) model = (await probeModelDescriptors(config))[0]?.id;
    if (!model) return;
    try {
      await deps.applyModelSwitch(providerId, model);
    } catch {
      // Best effort: the persisted provider becomes the default next session.
    }
  }

  return {
    handleProvidersList,
    handleProvidersSaved,
    handleProviderModels,
    handleProviderModelsSearch,
    collectFallbackCandidates,
    adoptDefaultProviderIfUnset,
  };
}
