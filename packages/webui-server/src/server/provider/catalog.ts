import { hasProviderCredential, resolveProviderModelList } from '@wrongstack/core/models';
import type { ModelsRegistry } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import {
  resolveProviderCatalogForModels,
  resolveProviderModelMetadata,
  SIBLING_CATALOG,
} from '../model-catalog.js';
import { searchCatalogModels } from '../model-catalog-search.js';
import { errMessage } from '../ws-utils.js';
import type { ProviderServiceContext } from './mutations.js';
import { probeModelDescriptors, projectSavedProviders } from './projection.js';

/**
 * Catalog + model-resolution surface (6B-2). Moved verbatim from
 * provider-handlers.ts: list/saved/search/models handlers plus the
 * default-provider adoption flow.
 */
export function createCatalogHandlers(ctx: ProviderServiceContext) {
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
        payload: { providers: projectSavedProviders(await ctx.loadConfigProviders()) },
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

  async function handleProviderModels(ws: WebSocket, providerId: string): Promise<void> {
    if (!ctx.deps.modelsRegistry) {
      ctx.sendOperationResult(ws, false, 'Models registry not available');
      return;
    }
    try {
      const saved = await ctx.loadConfigProviders();
      const config = saved[providerId];
      const provider = await resolveProviderCatalogForModels(
        ctx.deps.modelsRegistry,
        providerId,
        config,
      );
      const siblingCatalogKey = config?.family ?? providerId;
      const siblingId = SIBLING_CATALOG[siblingCatalogKey];
      const sibling =
        siblingId && siblingId !== providerId
          ? await ctx.deps.modelsRegistry.getProvider(siblingId).catch(() => undefined)
          : undefined;
      let models = resolveProviderModelList(
        config?.models,
        provider,
        config?.type ?? providerId,
        sibling,
      );
      if (models.length === 0 && config?.baseUrl) models = await probeModelDescriptors(config);
      const enriched = await Promise.all(
        models.map(async (model) => {
          if (model.contextWindow && model.capabilities.length > 0) return model;
          const resolved = await resolveProviderModelMetadata(
            ctx.deps.modelsRegistry as ModelsRegistry,
            providerId,
            model.id,
            config,
          ).catch(() => undefined);
          if (!resolved) return model;
          const capabilities = new Set(model.capabilities);
          if (resolved.capabilities.tools) capabilities.add('tools');
          if (resolved.capabilities.reasoning) capabilities.add('reasoning');
          if (resolved.capabilities.vision) capabilities.add('vision');
          return {
            ...model,
            contextWindow: model.contextWindow ?? resolved.capabilities.maxContext ?? undefined,
            inputCost: model.inputCost ?? resolved.cost?.input,
            outputCost: model.outputCost ?? resolved.cost?.output,
            capabilities: [...capabilities],
          };
        }),
      );
      ctx.sendMessage(ws, {
        type: 'provider.models',
        payload: { provider: providerId, models: enriched },
      });
    } catch (error) {
      ctx.sendOperationResult(ws, false, errMessage(error));
    }
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
    adoptDefaultProviderIfUnset,
  };
}
