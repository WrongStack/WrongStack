/**
 * Per-request resolution of a model's output-token ceiling.
 *
 * The wire adapters used to write `req.maxTokens ?? ctx.capabilities.maxOutput ?? 8192`,
 * which quietly collapsed to the 8192 literal in every situation where
 * `ctx.capabilities` was not the catalog-resolved capabilities for the model
 * actually being requested:
 *
 *   - `withCatalogCapabilities` runs ONCE at boot, for `config.model`. Every
 *     runtime provider rebuild (`/model` switch, fallback chain, session
 *     resume, fleet host provider, WebUI switch) constructs a fresh Provider
 *     carrying only the family baseline — where `maxOutput` is undefined.
 *   - A single Provider instance serves requests for more than one model
 *     (subagents on a model-matrix entry, the fallback chain), so a
 *     provider-scoped `maxOutput` is structurally the wrong granularity.
 *
 * The result was that a model advertising `limit.output: 64000` on models.dev
 * got `max_tokens: 8192` on the wire — responses truncated at 1/8th of the
 * model's real ceiling.
 *
 * This module keys the lookup on `req.model`, which is always the model being
 * requested, and reads the same models.dev facts (`limit.output`) that the
 * catalog overlay reads. The resolver is installed once at boot by whichever
 * host owns the ModelsRegistry (CLI wiring, WebUI server); when it is absent
 * — plugin-built providers, unit tests, catalog unreachable — resolution falls
 * through to the provider capabilities and finally to the documented literal.
 */
import type {
  Capabilities,
  Config,
  ModelsDevPayload,
  ModelsRegistry,
  ProviderConfig,
  Request,
} from '@wrongstack/core/types';
import {
  CATALOG_ALIAS_BY_PROVIDER_TYPE,
  FAMILY_BY_PROVIDER_ID,
  SIBLING_CATALOG_BY_FAMILY,
} from './capabilities.js';

/**
 * The ONLY hardcoded output number left in the codebase, and it exists solely
 * because Anthropic's Messages API makes `max_tokens` a REQUIRED field: with no
 * catalog entry and no capability overlay there is nothing to derive from, and
 * a request without the field is rejected outright.
 *
 * Every other wire format treats the cap as optional, so they omit it instead
 * (see `resolveMaxOutputTokens` returning undefined) and let the backend apply
 * the model's own ceiling — the correct number, sourced from the provider
 * rather than guessed here.
 *
 * Do NOT reuse this as a general default.
 */
export const REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT = 8192;

/** Context handed to `buildBody`, carrying everything needed to size a response. */
export interface BuildBodyContext {
  capabilities: Capabilities;
  /**
   * The Provider's user-visible id. Optional so hand-written adapters and
   * tests that call `buildBody` directly keep compiling; when absent the
   * catalog lookup is skipped and capability/fallback resolution applies.
   */
  providerId?: string | undefined;
}

export type ModelOutputLimitResolver = (
  providerId: string | undefined,
  modelId: string,
) => number | undefined;

let activeResolver: ModelOutputLimitResolver | undefined;

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * Install the process-wide catalog resolver. Hosts normally call
 * {@link installCatalogModelOutputLimits} instead; this is the seam for tests
 * and for embedders with their own catalog.
 */
export function setModelOutputLimitResolver(resolver: ModelOutputLimitResolver | undefined): void {
  activeResolver = resolver;
}

/** Drop the installed resolver. Tests use this to restore global state. */
export function clearModelOutputLimitResolver(): void {
  activeResolver = undefined;
}

/**
 * The model's advertised output ceiling, or undefined when no resolver is
 * installed / the model is unknown. Never throws: a resolver that blows up
 * must not take down request building.
 */
export function resolveCatalogMaxOutput(
  providerId: string | undefined,
  modelId: string,
): number | undefined {
  if (!activeResolver || !modelId) return undefined;
  try {
    return positive(activeResolver(providerId, modelId));
  } catch {
    return undefined;
  }
}

/**
 * The output-token cap for one request, highest-priority source first:
 *
 *  1. `req.maxTokens`            — the caller asked for a specific size
 *                                  (one-shot LLM callers, compaction helpers,
 *                                  the brain's configured budget).
 *  2. catalog, keyed on `req.model` — models.dev `limit.output`, plus the
 *                                  user's `customModels` / per-provider
 *                                  overrides from providers.json. Correct even
 *                                  when the provider instance was built for
 *                                  another model.
 *  3. `ctx.capabilities.maxOutput` — the boot-time overlay; still right for
 *                                  the common single-model session, and the
 *                                  only source when no resolver is installed.
 *
 * Returns undefined when none of them knows. Callers on a wire format where
 * the field is optional MUST omit it in that case rather than substitute a
 * number: the backend's own default is the model's real ceiling, whereas any
 * literal we invent here is a guess that silently truncates responses (this is
 * exactly how a fixed 8192 came to cap models with a 384_000 ceiling).
 */
export function resolveMaxOutputTokens(
  req: Pick<Request, 'model' | 'maxTokens'>,
  ctx: BuildBodyContext,
): number | undefined {
  return (
    positive(req.maxTokens) ??
    resolveCatalogMaxOutput(ctx.providerId, req.model) ??
    positive(ctx.capabilities.maxOutput)
  );
}

/**
 * Same resolution, for wire formats that REQUIRE the field (Anthropic
 * Messages). Falls back to {@link REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT} only
 * when nothing is known, because omitting it would make the request invalid.
 */
export function resolveRequiredMaxOutputTokens(
  req: Pick<Request, 'model' | 'maxTokens'>,
  ctx: BuildBodyContext,
): number {
  return resolveMaxOutputTokens(req, ctx) ?? REQUIRED_FIELD_LAST_RESORT_MAX_OUTPUT;
}

export interface InstallCatalogOutputLimitsOptions {
  registry: ModelsRegistry;
  /**
   * Live config reader. Re-read on every lookup so a `/models add --max-output`
   * or a hot-reloaded provider config takes effect without a restart.
   */
  getConfig?: (() => Config | undefined) | undefined;
  log?: ((message: string) => void) | undefined;
}

/** `providerId -> modelId -> limit.output`, rebuilt whenever the catalog changes. */
type OutputLimitIndex = Map<string, Map<string, number>>;

interface OutputLimitState {
  index: OutputLimitIndex;
}

const OUTPUT_LIMIT_STATES = new WeakMap<ModelsRegistry, OutputLimitState>();

function indexPayload(payload: ModelsDevPayload): OutputLimitIndex {
  const index: OutputLimitIndex = new Map();
  for (const [providerId, provider] of Object.entries(payload)) {
    const models = new Map<string, number>();
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      const output = positive(model.limit?.output);
      if (output !== undefined) models.set(modelId, output);
    }
    if (models.size > 0) index.set(providerId, models);
  }
  return index;
}

function providerCfgFor(
  config: Config | undefined,
  providerId: string,
): ProviderConfig | undefined {
  return config?.providers?.[providerId];
}

/**
 * User overrides for one (provider, model), mirroring the chain in
 * `capabilitiesFor`: a per-model `customModels` entry wins over a
 * provider-wide `capabilities` override.
 */
function overrideMaxOutput(
  config: Config | undefined,
  providerId: string,
  modelId: string,
): number | undefined {
  const cfg = providerCfgFor(config, providerId);
  if (!cfg) return undefined;
  const custom = cfg.customModels?.[modelId];
  const fromCustom = positive(custom?.maxOutput) ?? positive(custom?.capabilities?.maxOutput);
  if (fromCustom !== undefined) return fromCustom;
  return positive((cfg.capabilities as { maxOutput?: unknown } | undefined)?.maxOutput);
}

/**
 * Catalog ids to try for a user-visible provider id, in order:
 *   1. the id itself (plain catalog entry)
 *   2. the saved config's `type` (saved-config alias, e.g.
 *      `minimax-coding-plan` → `anthropic`)
 *   3. the sibling catalog for the wire family (OAuth/subscription providers
 *      that are absent from models.dev: `anthropic-oauth` → `anthropic`,
 *      `github-copilot` / `openai-codex` → `openai`)
 */
function catalogIdsFor(config: Config | undefined, providerId: string): string[] {
  const ids = [providerId];
  const cfg = providerCfgFor(config, providerId);
  if (cfg?.type && cfg.type !== providerId) ids.push(cfg.type);
  const family = cfg?.family ?? FAMILY_BY_PROVIDER_ID[providerId];
  const sibling = family ? SIBLING_CATALOG_BY_FAMILY[family] : undefined;
  if (sibling && !ids.includes(sibling)) ids.push(sibling);
  // Gateways publish under a models.dev id of their own (`ai-gateway` →
  // `vercel`). Keyed on the config TYPE too, so a user alias resolves as well.
  for (const key of [providerId, cfg?.type]) {
    const alias = key ? CATALOG_ALIAS_BY_PROVIDER_TYPE[key] : undefined;
    if (alias && !ids.includes(alias)) ids.push(alias);
  }
  return ids;
}

/**
 * Build the catalog index from the registry and install it as the process-wide
 * output-limit resolver. Safe to call more than once — the last install wins.
 *
 * Resolves after the first index build so boot can guarantee the very first
 * request already sees real limits. A catalog that is unreachable leaves the
 * resolver installed with an empty index: config overrides still apply and
 * everything else falls through to the capability overlay.
 */
export async function installCatalogModelOutputLimits(
  opts: InstallCatalogOutputLimitsOptions,
): Promise<void> {
  const { registry, getConfig, log } = opts;
  let state = OUTPUT_LIMIT_STATES.get(registry);
  if (!state) {
    state = { index: new Map() };
    OUTPUT_LIMIT_STATES.set(registry, state);
  }

  const prime = async (force: boolean): Promise<void> => {
    try {
      state.index = indexPayload(await registry.load(force ? { force: true } : undefined));
    } catch (err) {
      log?.(
        `Model output-limit index unavailable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  await prime(false);

  // A catalog refresh replaces every limit — rebuild rather than serve stale
  // numbers. Mirrors the cache invalidation `capabilitiesFor` installs.
  if (typeof registry.refresh === 'function' && !WRAPPED_REFRESH.has(registry)) {
    const originalRefresh = registry.refresh.bind(registry);
    registry.refresh = async () => {
      const payload = await originalRefresh();
      state.index = indexPayload(payload);
      return payload;
    };
    WRAPPED_REFRESH.add(registry);
  }

  // Runtime-discovered models carry real `limit.output` values, but they arrive
  // through `mergeOverlay`, which never rebuilt this index — so a discovered
  // model's ceiling stayed invisible until the next refresh and every request
  // fell through to the 8192 last resort. Index the overlay payload directly:
  // it is the exact delta, so this stays synchronous and needs no reload.
  const overlayHolder = registry as {
    mergeOverlay?: (payload: ModelsDevPayload) => void;
  };
  if (typeof overlayHolder.mergeOverlay === 'function' && !WRAPPED_OVERLAY.has(registry)) {
    const originalMerge = overlayHolder.mergeOverlay.bind(registry);
    overlayHolder.mergeOverlay = (payload: ModelsDevPayload) => {
      originalMerge(payload);
      for (const [catalogId, models] of indexPayload(payload)) {
        const existing = state.index.get(catalogId);
        if (existing) for (const [id, limit] of models) existing.set(id, limit);
        else state.index.set(catalogId, models);
      }
    };
    WRAPPED_OVERLAY.add(registry);
  }

  setModelOutputLimitResolver((providerId, modelId) => {
    if (!providerId) return undefined;
    const config = getConfig?.();
    const override = overrideMaxOutput(config, providerId, modelId);
    if (override !== undefined) return override;
    for (const catalogId of catalogIdsFor(config, providerId)) {
      const limit = state.index.get(catalogId)?.get(modelId);
      if (limit !== undefined) return limit;
    }
    return undefined;
  });
}

const WRAPPED_REFRESH = new WeakSet<ModelsRegistry>();
const WRAPPED_OVERLAY = new WeakSet<ModelsRegistry>();
