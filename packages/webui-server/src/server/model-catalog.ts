import type {
  Capabilities,
  ModelsRegistry,
  ProviderConfig,
  ResolvedModel,
  ResolvedProvider,
} from '@wrongstack/core/types';
import { capabilitiesFor } from '@wrongstack/providers';

export const SIBLING_CATALOG: Record<string, string> = {
  'anthropic-oauth': 'anthropic',
  'openai-codex': 'openai',
  'github-copilot': 'openai',
};

/**
 * Resolve the catalog entry to use for a saved provider's WebUI model list.
 * Runtime discovery injects provider-specific catalogs under the saved provider
 * id (for example `omniroute`), while older aliases may still need to fall
 * back to their generic wire/catalog `type`.
 */
export async function resolveProviderCatalogForModels(
  modelsRegistry: Pick<ModelsRegistry, 'getProvider'>,
  providerId: string,
  cfg: Pick<ProviderConfig, 'type'> | undefined,
): Promise<ResolvedProvider | undefined> {
  return (
    (await modelsRegistry.getProvider(providerId)) ??
    (cfg?.type && cfg.type !== providerId ? await modelsRegistry.getProvider(cfg.type) : undefined)
  );
}

/**
 * Resolve model metadata for a selected config provider. Prefer the saved
 * provider id so provider-specific runtime discovery (for example Omniroute)
 * supplies context/cost/capability metadata; fall back to cfg.type for aliases.
 */
export async function resolveProviderModelMetadata(
  modelsRegistry: Pick<ModelsRegistry, 'getModel' | 'getProvider'> &
    Partial<Pick<ModelsRegistry, 'listProviders'>>,
  providerId: string,
  modelId: string,
  cfg:
    | Pick<ProviderConfig, 'type' | 'family' | 'models' | 'customModels' | 'capabilities'>
    | undefined,
): Promise<ResolvedModel | undefined> {
  const direct = await modelsRegistry.getModel(providerId, modelId).catch(() => undefined);
  if (direct) return overlayConfiguredCapabilities(direct, cfg);

  if (cfg?.type && cfg.type !== providerId) {
    const typed = await modelsRegistry.getModel(cfg.type, modelId).catch(() => undefined);
    if (typed) return overlayConfiguredCapabilities(typed, cfg);
  }

  const sibling = cfg?.family ? SIBLING_CATALOG[cfg.family] : undefined;
  if (sibling) {
    const siblingModel = await modelsRegistry.getModel(sibling, modelId).catch(() => undefined);
    if (siblingModel) return overlayConfiguredCapabilities(siblingModel, cfg);
    const caps = await capabilitiesFor(
      modelsRegistry as ModelsRegistry,
      sibling,
      modelId,
      cfg?.customModels,
    ).catch(() => undefined);
    if (caps && positiveNumber(caps.maxContext)) {
      return syntheticModel(providerId, modelId, cfg, caps);
    }
  }

  const catalogId = cfg?.type && cfg.type !== providerId ? cfg.type : providerId;
  const caps = await capabilitiesFor(
    modelsRegistry as ModelsRegistry,
    catalogId,
    modelId,
    cfg?.customModels,
  ).catch(() => undefined);
  if (caps && positiveNumber(caps.maxContext)) {
    return syntheticModel(providerId, modelId, cfg, caps);
  }

  const crossCatalog = await findModelAcrossCatalog(modelsRegistry, modelId);
  if (crossCatalog) return overlayConfiguredCapabilities(crossCatalog, cfg);

  return syntheticModel(providerId, modelId, cfg);
}

async function findModelAcrossCatalog(
  modelsRegistry: Partial<Pick<ModelsRegistry, 'listProviders' | 'getModel'>>,
  modelId: string,
): Promise<ResolvedModel | undefined> {
  if (
    typeof modelsRegistry.listProviders !== 'function' ||
    typeof modelsRegistry.getModel !== 'function'
  ) {
    return undefined;
  }
  const providers = await modelsRegistry.listProviders().catch(() => []);
  for (const provider of providers) {
    if (!provider.models.some((model) => model.id === modelId)) continue;
    const resolved = await modelsRegistry.getModel(provider.id, modelId).catch(() => undefined);
    if (resolved?.capabilities?.maxContext) return resolved;
  }
  return undefined;
}

function syntheticModel(
  providerId: string,
  modelId: string,
  cfg: Pick<ProviderConfig, 'models' | 'customModels' | 'capabilities'> | undefined,
  capabilities?: Partial<Capabilities> | undefined,
): ResolvedModel | undefined {
  const custom = cfg?.customModels?.[modelId];
  const configuredMax = positiveNumber(readConfiguredMaxContext(cfg));
  const customCaps = custom?.capabilities;
  const maxContext =
    positiveNumber(customCaps?.maxContext) ??
    positiveNumber(capabilities?.maxContext) ??
    configuredMax ??
    0;
  const isKnown =
    Boolean(custom) ||
    Boolean(cfg?.models?.includes(modelId)) ||
    maxContext > 0 ||
    Boolean(capabilities);
  if (!isKnown) return undefined;
  return {
    providerId,
    modelId,
    capabilities: {
      tools: readConfiguredBool(cfg, 'tools') ?? capabilities?.tools ?? customCaps?.tools ?? false,
      vision:
        readConfiguredBool(cfg, 'vision') ?? capabilities?.vision ?? customCaps?.vision ?? false,
      reasoning:
        readConfiguredBool(cfg, 'reasoning') ??
        capabilities?.reasoning ??
        customCaps?.reasoning ??
        false,
      maxContext,
      maxOutput: custom?.maxOutput ?? customCaps?.maxOutput ?? capabilities?.maxOutput,
    },
    cost: undefined,
  };
}

function overlayConfiguredCapabilities(
  model: ResolvedModel,
  cfg: Pick<ProviderConfig, 'customModels' | 'capabilities'> | undefined,
): ResolvedModel {
  const custom = cfg?.customModels?.[model.modelId];
  const configuredMax = positiveNumber(readConfiguredMaxContext(cfg));
  const customCaps = custom?.capabilities;
  if (!configuredMax && !customCaps && custom?.maxOutput === undefined) return model;
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      ...customCaps,
      maxContext: customCaps?.maxContext ?? configuredMax ?? model.capabilities.maxContext,
      maxOutput: custom?.maxOutput ?? customCaps?.maxOutput ?? model.capabilities.maxOutput,
    },
  };
}

function readConfiguredMaxContext(providerConfig: unknown): number | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const capabilities = (providerConfig as { capabilities?: unknown | undefined }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  return (capabilities as Partial<Capabilities>).maxContext;
}

function readConfiguredBool(
  providerConfig: unknown,
  key: 'tools' | 'vision' | 'reasoning',
): boolean | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const capabilities = (providerConfig as { capabilities?: unknown | undefined }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  const value = (capabilities as Partial<Capabilities>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
