import type {
  Capabilities,
  Config,
  CustomModelDefinition,
  Logger,
  ModelsRegistry,
  Provider,
  ProviderConfig,
} from '@wrongstack/core/types';
import { mergeCustomModelDefs, toErrorMessage } from '@wrongstack/core/utils';
import { capabilitiesFor } from '@wrongstack/providers';

/**
 * Config-only OAuth/subscription wire families → the canonical models.dev
 * provider that lists the same models. Lets us resolve the real per-model
 * context window (these families aren't published in the catalog themselves).
 */
const SIBLING_CATALOG: Record<string, string> = {
  'anthropic-oauth': 'anthropic',
  'openai-codex': 'openai',
  'github-copilot': 'openai',
};

interface ResolveMaxContextInput {
  modelsRegistry?: ModelsRegistry | undefined;
  config: {
    provider?: string | undefined;
    model?: string | undefined;
    baseUrl?: string | undefined;
    context?: { effectiveMaxContext?: number | undefined } | undefined;
    providers?: Config['providers'] | undefined;
    models?: Record<string, CustomModelDefinition> | undefined;
  };
  provider: Provider;
  /** Provider config actually used to construct `provider` (important for aliases). */
  runtimeProviderConfig?: ProviderConfig | undefined;
  providerId: string;
  modelId: string;
}

/**
 * Resolve the max context WrongStack should use for compaction/status UI.
 *
 * Priority chain (first hit wins):
 *  1. providers.<id>.capabilities.maxContext    — explicit per-provider override.
 *     Provider-SCOPED, so it can't silently pin unrelated providers.
 *  2. own catalog entry, else sibling, for OAuth families — when the family is
 *     itself published under its own id (openai-codex ships via the curated
 *     overlay), that entry is authoritative. Otherwise
 *     anthropic-oauth/openai-codex/github-copilot share their models with a
 *     canonical models.dev provider (anthropic/openai) but aren't themselves
 *     listed, so resolve the real per-model window there
 *     (e.g. Opus 4.8 → 1M, gpt-5.5 → 1.05M)
 *  3. models.dev catalog (capabilitiesFor → getModel) — the published per-model
 *     window, keyed by provider (e.g. 1M for an OpenRouter model)
 *  4. config.context.effectiveMaxContext        — global FALLBACK for models whose
 *     window nothing published. It deliberately ranks BELOW the catalog: it is a
 *     single model-agnostic number, so honoring it above per-model facts pins
 *     every model of every provider to one value forever, invisibly. (A stale
 *     128k here once collapsed 1M-window models to 128k across the whole config.)
 *     To cap ONE provider on purpose, use (1) — that is what it is for.
 *  5. provider.capabilities.maxContext          — family default (may be 0)
 *
 * Returns 0 when the context window cannot be determined — callers should
 * treat this as "unknown" and disable auto-compaction rather than guessing.
 *
 * A configured `baseUrl` only changes the wire endpoint, NOT the model's
 * published context window, so it does NOT by itself suppress the catalog:
 * adding a catalog provider persists its own canonical `apiBase` as `baseUrl`
 * (e.g. OpenRouter → https://openrouter.ai/api/v1), which is not a custom proxy.
 * Only a baseUrl that DIVERGES from the catalog apiBase (a local proxy/gateway
 * whose real window may be smaller) skips the catalog — and even then the
 * explicit overrides (1) and (2) can raise the window back.
 */
/**
 * Which branch of the priority chain produced the resolved max-context value.
 * Emitted as debug telemetry so mid-session window changes can be traced to
 * their cause (e.g. a family-default fallthrough or a diverging proxy baseUrl
 * that silently shrinks the window). See {@link resolveRuntimeMaxContextDetailed}.
 */
export type MaxContextBranch =
  | 'explicit-config-fallback'
  | 'provider-override'
  | 'sibling-capabilities'
  | 'sibling-direct-model'
  | 'catalog-capabilities'
  | 'catalog-direct-model'
  | 'family-default'
  | 'diverging-baseurl-family-default'
  | 'unknown';

interface ResolvedMaxContext {
  /** The resolved window (0 = unknown). */
  maxContext: number;
  /** The priority-chain branch that produced {@link maxContext}. */
  branch: MaxContextBranch;
}

/**
 * Detailed variant of {@link resolveRuntimeMaxContext} that also reports which
 * branch of the priority chain produced the value. Prefer this at wiring sites
 * that emit telemetry; the plain {@link resolveRuntimeMaxContext} stays a thin
 * value-only wrapper for existing callers and tests.
 */
export async function resolveRuntimeMaxContextDetailed(
  input: ResolveMaxContextInput,
): Promise<ResolvedMaxContext> {
  const providerConfig = input.runtimeProviderConfig ?? input.config.providers?.[input.providerId];
  const providerOverride = positiveNumber(readConfiguredMaxContext(providerConfig));
  if (providerOverride) return { maxContext: providerOverride, branch: 'provider-override' };

  // Resolve alias → catalog id so registry lookups hit the real provider. The
  // launch id (input.providerId) may be a user alias whose `type` points at the
  // catalog provider (mirrors `wstack models <provider>`).
  const catalogId =
    providerConfig?.type && providerConfig.type !== input.providerId
      ? providerConfig.type
      : input.providerId;

  // OAuth/subscription families (Sign in with Claude/ChatGPT/Copilot) aren't in
  // the models.dev catalog under their own id, but they serve the SAME models as
  // a canonical catalog provider. When the family IS published under its own id
  // (openai-codex ships via the curated overlay), that entry is authoritative —
  // check it before the sibling so a stale sibling listing (e.g. models.dev
  // `openai` still showing a smaller window for a model the overlay declares
  // 1M) can't cap it. Only an unpublished own id falls through to the sibling.
  // The configured baseUrl is an auth/proxy endpoint (api.anthropic.com, a
  // Copilot proxy, …), not a context-shrinking gateway, so we bypass the
  // divergence guard that the generic catalog path applies below.
  const sibling = providerConfig?.family ? SIBLING_CATALOG[providerConfig.family] : undefined;
  if (sibling && input.modelsRegistry) {
    const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, input.config.models);

    // Own entry first. The getModel() gate distinguishes "published under the
    // own id" from a miss — capabilitiesFor alone would return the family
    // default for an unpublished model and mislabel it as a catalog fact.
    const ownModel = await input.modelsRegistry
      .getModel(catalogId, input.modelId)
      .catch(() => undefined);
    if (ownModel) {
      const ownCaps = await capabilitiesFor(
        input.modelsRegistry,
        catalogId,
        input.modelId,
        mergedModels,
      ).catch(() => undefined);
      const ownMax =
        positiveNumber(ownCaps?.maxContext) ??
        positiveNumber(ownModel.capabilities.maxContext);
      if (ownMax) return { maxContext: ownMax, branch: 'catalog-capabilities' };
    }

    const caps = await capabilitiesFor(
      input.modelsRegistry,
      sibling,
      input.modelId,
      mergedModels,
    ).catch(() => undefined);
    const siblingMax = positiveNumber(caps?.maxContext);
    if (siblingMax) return { maxContext: siblingMax, branch: 'sibling-capabilities' };

    const directModel = await input.modelsRegistry
      .getModel(sibling, input.modelId)
      .catch(() => undefined);
    const directMax = positiveNumber(directModel?.capabilities.maxContext);
    if (directMax) return { maxContext: directMax, branch: 'sibling-direct-model' };
  }

  // Hoisted to function scope so the final family-default return can report
  // whether a diverging proxy/gateway baseUrl (a silent-shrink cause) is why
  // the catalog was skipped.
  let divergedFromCatalog = false;

  if (input.modelsRegistry) {
    const topLevelBaseUrlApplies = input.providerId === input.config.provider;
    const configuredBaseUrl =
      providerConfig?.baseUrl ?? (topLevelBaseUrlApplies ? input.config.baseUrl : undefined);

    // A baseUrl only suppresses the catalog when it points somewhere OTHER than
    // the provider's canonical endpoint. When unset, or equal to the catalog
    // apiBase, the model's published window still applies.
    let divergesFromCatalog = false;
    if (configuredBaseUrl) {
      const resolved = await safeGetProvider(input.modelsRegistry, catalogId);
      divergesFromCatalog =
        normalizeBaseUrl(configuredBaseUrl) !== normalizeBaseUrl(resolved?.apiBase);
    }
    divergedFromCatalog = divergesFromCatalog;

    if (!divergesFromCatalog) {
      // Phase 1 — capabilitiesFor(): merges per-model catalog facts with family
      // defaults. This is the preferred path; for models with catalog data it
      // returns the authoritative limit (e.g. 1M for deepseek-v4-pro).
      const mergedModels = mergeCustomModelDefs(providerConfig?.customModels, input.config.models);
      const caps = await capabilitiesFor(
        input.modelsRegistry,
        catalogId,
        input.modelId,
        mergedModels,
      ).catch(() => undefined);
      const catalogMax = positiveNumber(caps?.maxContext);
      if (catalogMax) return { maxContext: catalogMax, branch: 'catalog-capabilities' };

      // Phase 2 — direct getModel() retry. If capabilitiesFor threw due to a
      // transient registry issue (stale cache, race on model refresh), a direct
      // model lookup may still succeed.
      const directModel = await input.modelsRegistry
        .getModel(catalogId, input.modelId)
        .catch(() => undefined);
      const directMax = positiveNumber(directModel?.capabilities.maxContext);
      if (directMax) return { maxContext: directMax, branch: 'catalog-direct-model' };
    }
  }

  // Catalog exhausted — NOW the global config value earns its keep. It is the
  // user's answer to "what window should I assume when nothing published one",
  // which is exactly the openai-compatible / coding-plan gateway case. Ranking
  // it here (not first) is what keeps a 1M-window model at 1M.
  const explicitContext = positiveNumber(input.config.context?.effectiveMaxContext);
  if (explicitContext) {
    return { maxContext: explicitContext, branch: 'explicit-config-fallback' };
  }

  // All catalog lookups exhausted — return the provider's raw capabilities.
  // This may be 0 for catch-all families like openai-compatible, which
  // signals "unknown context window" to callers.
  //
  // Distinguish WHY we landed here: a diverging proxy/gateway baseUrl skips the
  // catalog entirely (a common silent-shrink cause), versus the catalog simply
  // having no window for this model. The branch lets telemetry tell them apart.
  const familyDefault = positiveNumber(input.provider.capabilities.maxContext) ?? 0;
  const branch: MaxContextBranch =
    familyDefault === 0
      ? 'unknown'
      : divergedFromCatalog
        ? 'diverging-baseurl-family-default'
        : 'family-default';
  return { maxContext: familyDefault, branch };
}

/**
 * Value-only resolver — thin wrapper over {@link resolveRuntimeMaxContextDetailed}
 * for callers and tests that only need the number.
 */
export async function resolveRuntimeMaxContext(input: ResolveMaxContextInput): Promise<number> {
  const { maxContext } = await resolveRuntimeMaxContextDetailed(input);
  return maxContext;
}

/**
 * Branches whose fallthrough is a likely silent-shrink cause worth a warning.
 *
 * 'unknown' is deliberately EXCLUDED: the resolver only ever emits 'unknown'
 * paired with maxContext:0 (familyDefault === 0), and the shrink predicate
 * requires current > 0 — so a resolver-driven 'unknown' can never be a shrink.
 * The only way an 'unknown' branch reaches here is the branch-less external
 * caller (onModelContextResolved → intentional model switch), where a smaller
 * window is expected. Including it would fire a false-positive warn on every
 * switch to a smaller model, so it stays at debug.
 */
const SUSPICIOUS_SHRINK_BRANCHES: ReadonlySet<MaxContextBranch> = new Set([
  'family-default',
  'diverging-baseurl-family-default',
]);

interface MaxContextChangeTelemetry {
  /** Log severity for this change: 'warn' for a suspicious shrink, else 'debug'. */
  level: 'warn' | 'debug';
  /** Fully-rendered log line. */
  message: string;
  /** True when the window strictly decreased between two positive values. */
  shrank: boolean;
  /** The branch attributed to the new value (defaults to 'unknown'). */
  branch: MaxContextBranch;
}

/**
 * Pure decision for max-context change telemetry, shared by the runtime wiring
 * (applyMaxContext) and its tests. Returns `undefined` when the value did not
 * change (nothing to log). A strict decrease via a {@link SUSPICIOUS_SHRINK_BRANCHES}
 * branch is escalated to 'warn' — this is the fingerprint of the "context window
 * shrinks mid-session" bug class.
 */
export function describeMaxContextChange(params: {
  previous: number;
  current: number;
  providerId: string;
  modelId: string;
  branch?: MaxContextBranch | undefined;
}): MaxContextChangeTelemetry | undefined {
  const { previous, current, providerId, modelId } = params;
  if (current === previous) return undefined;

  const branch: MaxContextBranch = params.branch ?? 'unknown';
  const shrank = previous > 0 && current > 0 && current < previous;
  const suspicious = SUSPICIOUS_SHRINK_BRANCHES.has(branch);
  const detail =
    `max-context ${previous} → ${current} for ${providerId}/${modelId} ` +
    `(branch=${branch}${shrank ? ', DECREASED' : ''})`;

  return shrank && suspicious
    ? {
        level: 'warn',
        message: `Context window shrank via a non-catalog branch: ${detail}`,
        shrank,
        branch,
      }
    : { level: 'debug', message: detail, shrank, branch };
}

export async function refreshRuntimeModelCatalog(input: {
  modelsRegistry?: ModelsRegistry | undefined;
  logger?: Pick<Logger, 'debug' | 'warn'> | undefined;
  reason?: string | undefined;
}): Promise<boolean> {
  if (!input.modelsRegistry) return false;
  try {
    await input.modelsRegistry.refresh();
    input.logger?.debug?.(
      `models.dev catalog refreshed${input.reason ? ` (${input.reason})` : ''}`,
    );
    return true;
  } catch (err) {
    input.logger?.warn?.(
      `models.dev refresh failed${input.reason ? ` (${input.reason})` : ''}: ${toErrorMessage(err)}; using cached catalog`,
    );
    return false;
  }
}

/**
 * `getProvider` lookup that swallows BOTH synchronous throws (e.g. a partial
 * registry stub without the method) and async rejections, returning undefined.
 */
async function safeGetProvider(
  registry: ModelsRegistry,
  id: string,
): Promise<{ apiBase?: string | undefined } | undefined> {
  try {
    return await registry.getProvider(id);
  } catch {
    return undefined;
  }
}

/** Lowercase + strip trailing slashes so apiBase comparison is stable. */
function normalizeBaseUrl(url: string | undefined): string {
  if (!url) return '';
  return url.trim().toLowerCase().replace(/\/+$/, '');
}

function readConfiguredMaxContext(providerConfig: unknown): number | undefined {
  if (!providerConfig || typeof providerConfig !== 'object') return undefined;
  const capabilities = (providerConfig as { capabilities?: unknown | undefined }).capabilities;
  if (!capabilities || typeof capabilities !== 'object') return undefined;
  return (capabilities as Partial<Capabilities>).maxContext;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}
