import type {
  Capabilities,
  CustomModelDefinition,
  ModelsRegistry,
  ResolvedProvider,
  WireFamily,
} from '@wrongstack/core/types';
import { capabilitiesForFamily } from './family-capabilities.js';

const REGISTRY_CAP_CACHE = new WeakMap<ModelsRegistry, Map<string, Capabilities>>();
const CUSTOM_MODEL_IDS = new WeakMap<Record<string, CustomModelDefinition>, number>();
const WRAPPED_REFRESH = new WeakSet<ModelsRegistry>();
const WRAPPED_OVERLAY = new WeakSet<ModelsRegistry>();
let nextCustomModelId = 1;

export const FAMILY_BY_PROVIDER_ID: Partial<Record<string, WireFamily>> = {
  'anthropic-oauth': 'anthropic-oauth',
  'github-copilot': 'github-copilot',
  'openai-codex': 'openai-codex',
};

/**
 * Providers absent from models.dev whose per-model facts live under another
 * catalog id. Shared with `model-output-limits.ts` so the per-request output
 * ceiling resolves through exactly the same aliasing rules as the capability
 * overlay.
 */
export const SIBLING_CATALOG_BY_FAMILY: Partial<Record<WireFamily, string>> = {
  'anthropic-oauth': 'anthropic',
  'github-copilot': 'openai',
  'openai-codex': 'openai',
};

/**
 * Providers whose catalog entry lives under a models.dev id that is not their
 * own, keyed by provider TYPE rather than wire family (a gateway has no wire
 * family of its own).
 *
 * models.dev publishes the Vercel AI Gateway as provider `vercel`
 * (`npm: @ai-sdk/gateway`), and its model ids are already in gateway form —
 * `anthropic/claude-sonnet-5`. Do NOT try to resolve these by splitting the id
 * and looking the remainder up under `anthropic`: the two catalogs are not
 * guaranteed to agree on a slug. They happen to match for the Claude 5 family,
 * but the 4.x generation diverges (`anthropic/claude-sonnet-4.6` on the gateway
 * vs `claude-sonnet-4-6` on the provider), and a missed lookup silently drops
 * every limit back to a default.
 *
 * Shared with `model-output-limits.ts` so the per-request output ceiling
 * resolves through exactly the same aliasing rules as the capability overlay.
 */
export const CATALOG_ALIAS_BY_PROVIDER_TYPE: Partial<Record<string, string>> = {
  'ai-gateway': 'vercel',
};

/**
 * The models.dev id to read facts from for a saved provider entry. Checks the
 * config `type` first so a user alias (`gateway-work` → `type: "ai-gateway"`)
 * resolves the same as the canonical id.
 */
export function catalogProviderIdFor(providerId: string, type?: string | undefined): string {
  return (
    (type ? CATALOG_ALIAS_BY_PROVIDER_TYPE[type] : undefined) ??
    CATALOG_ALIAS_BY_PROVIDER_TYPE[providerId] ??
    (type && type !== providerId ? type : providerId)
  );
}

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

/**
 * Split a gateway model id (`"anthropic/claude-sonnet-5"`) into the upstream
 * catalog provider and its native model id. Only the FIRST separator is
 * significant — model ids may themselves contain slashes
 * (`"meta/llama-3.1-70b/instruct"`).
 */
export function splitGatewayModelId(
  modelId: string,
): { providerId: string; modelId: string } | undefined {
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return undefined;
  return { providerId: modelId.slice(0, slash), modelId: modelId.slice(slash + 1) };
}

export interface CapabilitiesForOptions {
  /**
   * models.dev id to read per-model facts from, when it differs from the
   * user-visible provider id (see {@link CATALOG_ALIAS_BY_PROVIDER_TYPE}).
   * Without it an AI Gateway provider resolves to the `unsupported` family —
   * whose baseline has `tools: false`, `streaming: false` and
   * `systemPrompt: false` — and the overlay silently strips every capability
   * the transport actually has.
   */
  catalogProviderId?: string | undefined;
  /**
   * Baseline to overlay catalog facts onto, replacing the wire-family default.
   * Pass a transport's self-declared capabilities when the family map cannot
   * describe it — otherwise an unknown provider id silently downgrades a fully
   * capable transport to the `unsupported` baseline.
   */
  baseCapabilities?: Capabilities | undefined;
}

/**
 * A model fact AND-ed with the wire-family baseline. An UNKNOWN fact
 * (`undefined`) inherits the baseline rather than restricting it — see the
 * tri-state note in `capabilitiesFor`.
 */
function gate(fact: boolean | undefined, baseline: boolean): boolean {
  return fact === undefined ? baseline : fact && baseline;
}

/**
 * `mergeOverlay` injects runtime-discovered models into the catalog. It is not
 * on the `ModelsRegistry` interface, so probe for it.
 *
 * Without this the cache negative-caches: any `(provider, model)` resolved
 * BEFORE discovery lands is pinned to the family baseline until the next
 * `refresh()`. That is exactly the "I entered a key but the model still has no
 * tools" failure, and it only reproduces when something touches capabilities
 * early — so it would surface as an intermittent bug, not a consistent one.
 */
function ensureOverlayInvalidatesCache(registry: ModelsRegistry): void {
  // Its own guard: a registry without `refresh` never enters WRAPPED_REFRESH,
  // so relying on that set would re-wrap on every call and build an unbounded
  // wrapper chain.
  if (WRAPPED_OVERLAY.has(registry)) return;
  const holder = registry as { mergeOverlay?: (payload: unknown) => void };
  if (typeof holder.mergeOverlay !== 'function') return;
  WRAPPED_OVERLAY.add(registry);
  const original = holder.mergeOverlay.bind(registry);
  holder.mergeOverlay = (payload: unknown) => {
    REGISTRY_CAP_CACHE.delete(registry);
    original(payload);
  };
}

function ensureRefreshInvalidatesCache(registry: ModelsRegistry): void {
  if (WRAPPED_REFRESH.has(registry)) return;
  ensureOverlayInvalidatesCache(registry);
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
  options?: CapabilitiesForOptions,
): Promise<Capabilities> {
  ensureRefreshInvalidatesCache(registry);
  const registryCache = REGISTRY_CAP_CACHE.get(registry) ?? new Map();
  REGISTRY_CAP_CACHE.set(registry, registryCache);

  const key = cacheKey(providerId, modelId, customModels);
  const cached = registryCache.get(key);
  if (cached) {
    return cached;
  }

  // Catalog lookups may run against an aliased id; the cache key, the family
  // map and the custom-model overrides all stay on the id the user typed.
  const catalogProviderId = options?.catalogProviderId ?? providerId;
  const provider = await registry.getProvider(catalogProviderId);
  const knownFamily = provider?.family !== 'unsupported' ? provider?.family : undefined;
  const family = knownFamily ?? FAMILY_BY_PROVIDER_ID[providerId] ?? 'unsupported';
  const siblingProviderId = SIBLING_CATALOG_BY_FAMILY[family];
  const siblingProvider =
    siblingProviderId && (!provider || provider.family === 'unsupported')
      ? await registry.getProvider(siblingProviderId)
      : undefined;
  const model =
    (await registry.getModel(catalogProviderId, modelId)) ??
    (siblingProviderId ? await registry.getModel(siblingProviderId, modelId) : undefined);
  const base = options?.baseCapabilities ?? capabilitiesForFamily(family);

  // User-defined custom model overrides take top priority when present.
  const customDef = customModels?.[modelId];
  const customCaps = customDef?.capabilities;
  // `CustomModelDefinition` carries the output ceiling in two places: the
  // top-level `maxOutput` (what `/models add --max-output` and the WebUI
  // model editor write) and `capabilities.maxOutput` (a full capability
  // overlay). Reading only the latter silently dropped every value the CLI
  // flag ever set.
  const customMaxOutput = customDef?.maxOutput ?? customCaps?.maxOutput;

  // Without any model info at all, return base (possibly with custom overrides).
  if (!model && !customCaps && customMaxOutput === undefined) {
    const value = { ...base };
    registryCache.set(key, value);
    return value;
  }

  // maxContext resolution:
  //  1. customCaps.maxContext              — user explicitly overrides
  //  2. model.capabilities.maxContext      — registry getModel()
  //  3. raw model limit.context            — direct provider.models fallback
  //  4. base.maxContext                    — family default
  //
  // NOTE: `limit.output` is deliberately NOT part of this chain. It names the
  // model's per-RESPONSE output ceiling, which is orders of magnitude smaller
  // than the context window (e.g. 8K output vs 200K context). Falling back to
  // it silently collapses the reported/compaction context window — the source
  // of "context window shrinks mid-session" bugs when a refreshed catalog entry
  // has `limit.context` missing but `limit.output` present. When the true
  // context window is unknown, fall through to the family default instead.
  //
  // maxOutput uses its own chain against `limit.output` below — that IS the
  // correct source for the per-response output ceiling and drives subagent
  // `Request.maxTokens` (Chimera etc.).
  const rawProvider = bestRawProvider(provider, siblingProvider);
  const rawModel = rawProvider?.models.find((m) => m.id === modelId);
  const catalogMaxContext =
    model?.capabilities.maxContext || rawModel?.limit?.context || base.maxContext;
  const catalogMaxOutput =
    model?.capabilities.maxOutput || rawModel?.limit?.output || base.maxOutput;

  // Per-field priority: customCaps (if set) → model facts AND-ed with base → base.
  // AND-ing with base is conservative: a model can't have a capability the
  // wire family doesn't support. Custom overrides skip this guard because
  // the user explicitly opted in.
  //
  // The facts are TRI-STATE. `ResolvedModel` coerces unknowns to `false` at the
  // registry boundary (`tool_call ?? false`), so read them from the raw catalog
  // entry, which preserves the distinction. It matters for runtime-discovered
  // models: a gateway that lists a model without metadata is saying "I don't
  // know", and treating that as "no tools" makes the model unusable as an agent
  // model. Only an EXPLICIT false restricts; silence inherits the baseline.
  const modelTools = rawModel ? rawModel.tool_call : model?.capabilities.tools;
  const modelVision = rawModel
    ? rawModel.modalities?.input
      ? rawModel.modalities.input.includes('image')
      : undefined
    : model?.capabilities.vision;
  const modelReasoning = rawModel
    ? (rawModel.reasoning ?? (rawModel.reasoningConfig !== undefined ? true : undefined))
    : model?.capabilities.reasoning;

  const value = {
    ...base,
    // Capability booleans: AND model facts with base unless custom overrides
    tools: customCaps?.tools ?? gate(modelTools, base.tools),
    parallelTools: customCaps?.parallelTools ?? gate(modelTools, base.parallelTools),
    vision: customCaps?.vision ?? gate(modelVision, base.vision),
    reasoning: customCaps?.reasoning ?? modelReasoning ?? base.reasoning,
    // Scalar fields: custom override wins, then catalog, then base
    maxContext: customCaps?.maxContext ?? catalogMaxContext,
    maxOutput: customMaxOutput ?? catalogMaxOutput,
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
