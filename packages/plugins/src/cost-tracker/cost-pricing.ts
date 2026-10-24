import type { PluginAPI } from '@wrongstack/contracts/types';
import { BoundedMap } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Pricing lookup chain (see the plugin's file-level doc in index.ts):
// pricingOverrides → bundledFromRegistry → PRICING → DEFAULT_PRICING.
// ---------------------------------------------------------------------------

/**
 * Per-model pricing in USD per 1 million tokens.
 *
 * Used by `pricingOverrides` (user config), `bundledFromRegistry`
 * (models.dev), and the bundled `PRICING` table. All three share
 * the same shape so the lookup chain can fall through uniformly.
 *
 * @public
 */
export interface ModelPricing {
  /** Cost per 1M input (prompt) tokens in USD. */
  input: number;
  /** Cost per 1M output (completion) tokens in USD. */
  output: number;
  /** Cost per 1M prompt-cache read tokens; input rate is the safe fallback. */
  cacheRead?: number | undefined;
}

/**
 * Bundled pricing baseline (USD per 1M tokens).
 *
 * Values are intentionally hardcoded — provider-side pricing changes
 * are picked up here per release. Users can override per-model via
 * `config.extensions['cost-tracker'].pricingOverrides` without waiting
 * for a plugin version bump. The models.dev registry (when available
 * via `api.modelsRegistry`) provides a second override layer that
 * beats this baseline automatically.
 *
 * @internal
 */
const PRICING: Record<string, ModelPricing> = {
  'gpt-4o': { input: 5.0, output: 15.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10.0, output: 30.0 },
  'gemini-1.5-pro': { input: 3.5, output: 10.5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  default: { input: 5.0, output: 15.0 },
};

const DEFAULT_PRICING: ModelPricing = { input: 5.0, output: 15.0 };

/**
 * User-supplied per-model pricing overrides, populated from
 * `config.extensions['cost-tracker'].pricingOverrides` during `setup()`.
 *
 * Keys are lowercased to match the case-insensitive lookup in
 * `estimateCost`. Takes highest priority in the lookup chain.
 *
 * @internal
 */
export const pricingOverrides: Record<string, ModelPricing> = {};

/**
 * Per-model pricing hydrated from the host's models registry
 * (`api.modelsRegistry`, backed by models.dev). Populated during
 * `setup()` as a fire-and-forget async operation. Second priority
 * in the lookup chain (beats bundled `PRICING`, loses to user
 * `pricingOverrides`).
 *
 * @internal
 */
export const bundledFromRegistry: Record<string, ModelPricing> = {};

/**
 * How long `setup()` waits for the models registry before giving up and
 * letting the session start.
 *
 * The loader runs plugin setups serially, so this is time every plugin
 * behind cost-tracker spends waiting. A warm registry resolves in
 * microseconds; this budget only bites on a cold, slow, or unreachable
 * network, where the right answer is to start the session and price from
 * the bundled table until the fetch lands.
 *
 * @internal
 */
const REGISTRY_HYDRATION_DEADLINE_MS = 2_000;

/**
 * Estimate the USD cost of a single LLM request.
 *
 * Uses the four-layer pricing lookup chain (first match wins, all keys
 * lowercased):
 *
 * 1. **User override** — `pricingOverrides[model]`, from
 *    `config.extensions['cost-tracker'].pricingOverrides`. Highest
 *    priority; lets users correct stale bundled rates immediately.
 * 2. **Registry** — `bundledFromRegistry[model]`, hydrated from the
 *    host's models.dev-backed `ModelsRegistry` on setup. Beats the
 *    bundled baseline so fresh catalog data wins automatically.
 * 3. **Bundled** — `PRICING[model]`, hardcoded per release.
 * 4. **Default** — `DEFAULT_PRICING` (input=$5, output=$15 per 1M),
 *    used when none of the above recognize the model name.
 *
 * Performance: caches the lowercased model key to avoid redundant
 * `.toLowerCase()` calls on repeated requests with the same model.
 *
 * @param model - The provider-reported model identifier (e.g. `'gpt-4o'`,
 *   `'custom-model'`). Case-insensitive — lowercased internally.
 * @param promptTokens - Number of input/prompt tokens consumed.
 * @param completionTokens - Number of output/completion tokens generated.
 * @returns Estimated cost in USD.
 *
 * @example
 * ```ts
 * // 1000 prompt + 500 completion tokens of gpt-4o ($5/$15 per 1M):
 * estimateCost('gpt-4o', 1000, 500);  // → 0.0125
 *
 * // Unknown model falls through to DEFAULT_PRICING:
 * estimateCost('future-model', 1000, 500);  // → 0.0125
 *
 * // User override of $10/$20 per 1M takes priority:
 * // (config: pricingOverrides: { 'gpt-4o': { input: 10, output: 20 } })
 * estimateCost('gpt-4o', 1000, 500);  // → 0.02
 * ```
 *
 * @public
 */
/** Model-id normalisation memo. Bounded — model ids come from provider
 * responses, so a misbehaving or proxying provider could otherwise mint
 * unbounded distinct keys. */
export const modelKeyCache = new BoundedMap<string, string>({ max: 256 });

export function ownValue<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

export function setOwnValue<T>(record: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function estimateCost(
  model: string,
  freshTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  // Cache the lowercased key to avoid redundant .toLowerCase() calls.
  let key = modelKeyCache.get(model);
  if (!key) {
    key = model.toLowerCase();
    modelKeyCache.set(model, key);
  }

  const unnamespaced = key.includes('/') ? key.split('/').pop()! : key;
  const pricing =
    ownValue(pricingOverrides, key) ??
    ownValue(pricingOverrides, unnamespaced) ??
    ownValue(bundledFromRegistry, key) ??
    ownValue(bundledFromRegistry, unnamespaced) ??
    ownValue(PRICING, key) ??
    ownValue(PRICING, unnamespaced) ??
    DEFAULT_PRICING;
  const inputCost =
    (freshTokens / 1_000_000) * pricing.input +
    (cachedTokens / 1_000_000) * (pricing.cacheRead ?? pricing.input);
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Apply user-supplied `pricingOverrides` (aliases `pricing_overrides`,
 * `pricing`) from the raw plugin config into {@link pricingOverrides}.
 * Sync, so the overrides are available for the first cost calculation.
 */
export function applyPricingOverrides(rawConfig: Record<string, unknown> | undefined): void {
  const userOverrides =
    rawConfig?.['pricingOverrides'] ?? rawConfig?.['pricing_overrides'] ?? rawConfig?.['pricing'];
  if (userOverrides && typeof userOverrides === 'object') {
    for (const [model, value] of Object.entries(userOverrides as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const v = value as Record<string, unknown>;
      const input = v['input'];
      const output = v['output'];
      if (typeof input !== 'number' || typeof output !== 'number') continue;
      // A non-finite rate (JSON `1e999` parses to Infinity) would make every
      // cost for this model non-finite — reject the whole entry.
      if (!Number.isFinite(input) || !Number.isFinite(output)) continue;
      const cacheRead = v['cacheRead'];
      setOwnValue(pricingOverrides, model.toLowerCase(), {
        input,
        output,
        ...(typeof cacheRead === 'number' && Number.isFinite(cacheRead) ? { cacheRead } : {}),
      });
    }
  }
}

/**
 * Hydrate {@link bundledFromRegistry} from the host's models registry,
 * waiting at most {@link REGISTRY_HYDRATION_DEADLINE_MS}.
 */
export async function hydrateRegistryPricing(api: PluginAPI): Promise<void> {
  // Hydrate `bundledFromRegistry` from the host's models registry.
  //
  // setup() AWAITS this so the registry layer is populated before it
  // returns — the first `provider.response` event then sees the whole
  // lookup chain. The registry's `load()` is cached, so on a warm cache
  // the await is near-instant.
  //
  // The await is bounded, though, because the plugin loader runs every
  // plugin's setup() SERIALLY (`core/plugin/loader.ts`): on a cold cache
  // `load()` goes to the network, bounded only by the registry's own
  // refreshTimeoutMs (15s by default), and every plugin queued behind
  // this one waited out that fetch before the session could start. A
  // pricing table is not worth stalling a boot for. Past the deadline we
  // stop waiting and let the fetch land late — a `provider.response` in
  // the meantime just prices from the bundled `PRICING` table, which is
  // exactly what happens when no registry is configured at all.
  if (api.modelsRegistry) {
    const hydrate = async (): Promise<number> => {
      const payload = await api.modelsRegistry!.load();
      let hydrated = 0;
      for (const provider of Object.values(payload)) {
        const providerModels = provider?.models;
        if (!providerModels) continue;
        for (const [modelId, model] of Object.entries(providerModels)) {
          const cost = model?.cost;
          if (
            cost &&
            typeof cost.input === 'number' &&
            typeof cost.output === 'number' &&
            Number.isFinite(cost.input) &&
            Number.isFinite(cost.output)
          ) {
            setOwnValue(bundledFromRegistry, modelId.toLowerCase(), {
              input: cost.input,
              output: cost.output,
              ...(typeof cost.cache_read === 'number' && Number.isFinite(cost.cache_read)
                ? { cacheRead: cost.cache_read }
                : {}),
            });
            hydrated += 1;
          }
        }
      }
      return hydrated;
    };

    const running = hydrate().then(
      (hydrated) => {
        api.log.info('cost-tracker: hydrated pricing from models registry', {
          models: hydrated,
        });
      },
      (err: unknown) => {
        // Defensive: a broken or absent registry must not break
        // cost-tracking. The lookup chain falls through to PRICING.
        api.log.warn(
          'cost-tracker: failed to hydrate pricing from models registry — using bundled PRICING',
          err,
        );
      },
    );

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      deadline = setTimeout(() => resolve('timeout'), REGISTRY_HYDRATION_DEADLINE_MS);
      // Do not hold the process open for a deadline nobody is waiting on.
      deadline.unref?.();
    });
    try {
      if ((await Promise.race([running.then(() => 'done' as const), timedOut])) === 'timeout') {
        api.log.info(
          'cost-tracker: models registry still loading — continuing with bundled PRICING',
          { deadlineMs: REGISTRY_HYDRATION_DEADLINE_MS },
        );
      }
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
}
