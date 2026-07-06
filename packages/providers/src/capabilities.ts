import type {
  Capabilities,
  CustomModelDefinition,
  ModelsRegistry,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/core';
import { capabilitiesForFamily } from './family-capabilities.js';

const REGISTRY_CAP_CACHE = new WeakMap<ModelsRegistry, Map<string, Capabilities>>();
const CUSTOM_MODEL_IDS = new WeakMap<Record<string, CustomModelDefinition>, number>();
const WRAPPED_REFRESH = new WeakSet<ModelsRegistry>();
let nextCustomModelId = 1;

const FAMILY_BY_PROVIDER_ID: Partial<Record<string, WireFamily>> = {
  'anthropic-oauth': 'anthropic-oauth',
  'github-copilot': 'github-copilot',
  'openai-codex': 'openai-codex',
};

const SIBLING_CATALOG_BY_FAMILY: Partial<Record<WireFamily, string>> = {
  'anthropic-oauth': 'anthropic',
  'github-copilot': 'openai',
  'openai-codex': 'openai',
};

function customCacheKey(customModels?: Record<string, CustomModelDefinition>): string {
  if (!customModels) return '';
  let id = CUSTOM_MODEL_IDS.get(customModels);
  if (id === undefined) {
    id = nextCustomModelId++;
    CUSTOM_MODEL_IDS.set(customModels, id);
  }
  return String(id);
}

function cacheKey(
  providerId: string,
  modelId: string,
  customModels?: Record<string, CustomModelDefinition>,
): string {
  return `${providerId}\u0000${modelId}\u0000${customCacheKey(customModels)}`;
}

function ensureRefreshInvalidatesCache(registry: ModelsRegistry): void {
  if (WRAPPED_REFRESH.has(registry)) return;
  // Registries in tests (or minimal mocks) may not expose refresh; skip wrapping
  // so the cache stays per-process for the lifetime of the registry. A real
  // catalog refresh on such a registry would be a no-op anyway.
  if (typeof registry.refresh !== 'function') return;
  const originalRefresh = registry.refresh.bind(registry);
  registry.refresh = async () => {
    REGISTRY_CAP_CACHE.delete(registry);
    return originalRefresh();
  };
  WRAPPED_REFRESH.add(registry);
}

/**
 * Resolve capabilities for a (provider, model) pair using the family default
 * as a baseline and overlaying per-model facts from the ModelsRegistry.
 *
 * Priority chain (highest first):
 *  1. customModels[modelId].capabilities  — user-defined per-model overrides
 *  2. model facts from registry           — sub-fields AND-ed with base
 *  3. family default                      — e.g. 32K for openai-compatible
 */
export async function capabilitiesFor(
  registry: ModelsRegistry,
  providerId: string,
  modelId: string,
  customModels?: Record<string, CustomModelDefinition>,
): Promise<Capabilities> {
  ensureRefreshInvalidatesCache(registry);
  const registryCache = REGISTRY_CAP_CACHE.get(registry) ?? new Map();
  REGISTRY_CAP_CACHE.set(registry, registryCache);

  const key = cacheKey(providerId, modelId, customModels);
  const cached = registryCache.get(key);
  if (cached) {
    return cached;
  }

  const provider = await registry.getProvider(providerId);
  const knownFamily = provider?.family !== 'unsupported' ? provider?.family : undefined;
  const family = knownFamily ?? FAMILY_BY_PROVIDER_ID[providerId] ?? 'unsupported';
  const siblingProviderId = SIBLING_CATALOG_BY_FAMILY[family];
  const siblingProvider =
    siblingProviderId && (!provider || provider.family === 'unsupported')
      ? await registry.getProvider(siblingProviderId)
      : undefined;
  const model =
    (await registry.getModel(providerId, modelId)) ??
    (siblingProviderId ? await registry.getModel(siblingProviderId, modelId) : undefined);
  const base = capabilitiesForFamily(family);

  // User-defined custom model overrides take top priority when present.
  const customDef = customModels?.[modelId];
  const customCaps = customDef?.capabilities;

  // Without any model info at all, return base (possibly with custom overrides).
  if (!model && !customCaps) {
    const value = { ...base };
    registryCache.set(key, value);
    return value;
  }

  // maxContext resolution:
  //  1. customCaps.maxContext              — user explicitly overrides
  //  2. model.capabilities.maxContext      — registry getModel()
  //  3. raw model limit.context            — direct provider.models fallback
  //  4. base.maxContext                    — family default
  // maxOutput uses the same chain against `limit.output` (the models.dev
  // field that names the model's per-response output ceiling). It's the
  // driver for subagent `Request.maxTokens` (Chimera etc.) — keeping it
  // out of the family table means a fresh models.dev sync automatically
  // picks up new model ceilings without a code change.
  const rawProvider = bestRawProvider(provider, siblingProvider);
  const rawModel = rawProvider?.models.find((m) => m.id === modelId);
  const catalogMaxContext =
    model?.capabilities.maxContext ||
    rawModel?.limit?.context ||
    rawModel?.limit?.output ||
    base.maxContext;
  const catalogMaxOutput =
    model?.capabilities.maxOutput ||
    rawModel?.limit?.output ||
    base.maxOutput;

  // Per-field priority: customCaps (if set) → model facts AND-ed with base → base.
  // AND-ing with base is conservative: a model can't have a capability the
  // wire family doesn't support. Custom overrides skip this guard because
  // the user explicitly opted in.
  const modelTools = model?.capabilities.tools ?? false;
  const modelVision = model?.capabilities.vision ?? false;
  const modelReasoning = model?.capabilities.reasoning ?? false;

  const value = {
    ...base,
    // Capability booleans: AND model facts with base unless custom overrides
    tools: customCaps?.tools ?? (modelTools && base.tools),
    parallelTools: customCaps?.parallelTools ?? (modelTools && base.parallelTools),
    vision: customCaps?.vision ?? (modelVision && base.vision),
    reasoning: customCaps?.reasoning ?? modelReasoning,
    // Scalar fields: custom override wins, then catalog, then base
    maxContext: customCaps?.maxContext ?? catalogMaxContext,
    maxOutput: customCaps?.maxOutput ?? catalogMaxOutput,
    streaming: customCaps?.streaming ?? base.streaming,
    promptCache: customCaps?.promptCache ?? base.promptCache,
    systemPrompt: customCaps?.systemPrompt ?? base.systemPrompt,
    jsonMode: customCaps?.jsonMode ?? base.jsonMode,
    cacheControl: customCaps?.cacheControl ?? base.cacheControl,
    // Extended parameters: custom override wins, then family default
    topK: customCaps?.topK ?? base.topK,
    frequencyPenalty: customCaps?.frequencyPenalty ?? base.frequencyPenalty,
    presencePenalty: customCaps?.presencePenalty ?? base.presencePenalty,
    seed: customCaps?.seed ?? base.seed,
    structuredOutput: customCaps?.structuredOutput ?? base.structuredOutput,
    logprobs: customCaps?.logprobs ?? base.logprobs,
    audio: customCaps?.audio ?? base.audio,
    multipleCompletions: customCaps?.multipleCompletions ?? base.multipleCompletions,
  };
  registryCache.set(key, value);
  return value;
}

function bestRawProvider(
  provider: ResolvedProvider | undefined,
  siblingProvider: ResolvedProvider | undefined,
): ResolvedProvider | undefined {
  if (provider && provider.family !== 'unsupported') return provider;
  return siblingProvider ?? provider;
}
