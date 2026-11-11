/**
 * Long-context PRICE CLIFF support for context-window management.
 *
 * Several providers bill the SAME model at a step-up rate once ONE request's
 * context crosses a published boundary (Anthropic/Gemini double above 200K,
 * OpenAI's long-context tiers start at 272K). Filling a 1M window on those
 * models therefore silently moves every request into the expensive tier, and
 * a window-relative compaction threshold (soft 0.7 of 1M = 700K) fires long
 * AFTER the money has already been spent.
 *
 * The fix is the Goose formula: trigger compaction at
 * `min(threshold x window, token_cap)`, where the cap comes from the model's
 * published price tiers instead of a hardcoded number.
 *
 * Layering: this module is pure arithmetic over the models.dev `cost` shape.
 * It never touches a registry, config loader, or provider — hosts resolve the
 * active model's `cost` and publish the cliff through
 * `ctx.meta[CONTEXT_PRICE_CLIFF_META]`, exactly like `effectiveMaxContext`.
 * The tier SHAPE is the one `usage-cost.ts` bills with (`tiers[] =
 * { tier: { type: 'context', size }, …rates }` plus the legacy scalar/object
 * `context_over_200k`), so what compaction avoids and what billing charges can
 * never drift apart.
 */

import type { ModelsDevModel } from '@wrongstack/contracts/types';

/**
 * Session meta key holding the resolved cliff (`{ cliffTokens, … }`). Written
 * by hosts on boot and on every model switch; read by the auto-compaction
 * middleware and by the context X-Ray surfaces. Deleted when the cliff is off.
 */
export const CONTEXT_PRICE_CLIFF_META = 'contextPriceCliffTokens';

/** Legacy models.dev encoding of the 200K step-up (scalar = its input rate). */
const LEGACY_TIER_SIZE = 200_000;

/** A cliff below this is a malformed catalog row, not a real pricing boundary. */
const MIN_CLIFF_TOKENS = 8_192;

/** Rates whose ratio to the base is inside this band are not a step-up. */
const RATE_EPSILON = 1e-9;

/** Price field pairs compared base → tier, in display priority order. */
const CLIFF_FIELDS = [
  ['input', 'input'],
  ['output', 'output'],
  ['cache_read', 'cacheRead'],
  ['cache_write', 'cacheWrite'],
] as const;

export type PriceCliffField = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

export interface ContextPriceCliff {
  /** Lowest published context boundary at which this model's rates step up. */
  cliffTokens: number;
  /** Ratio of the stepped-up rate to the base rate on the driving field (> 1). */
  multiplier: number;
  /** Which billed field produced the step-up. */
  field: PriceCliffField;
  /** Per-1M base rate of that field (0 when the catalog omits it). */
  baseRate: number;
  /** Per-1M rate of that field once the request is over {@link cliffTokens}. */
  cliffRate: number;
}

function finiteRate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface TierRow {
  size: number;
  rates: Record<string, unknown>;
}

/**
 * Every context-price boundary a model publishes, lowest first. Mirrors the
 * tier reader the billing path uses so both agree on where the money changes.
 */
function contextTierRows(cost: Record<string, unknown>): TierRow[] {
  const rows: TierRow[] = [];
  if (Array.isArray(cost['tiers'])) {
    for (const row of cost['tiers'] as unknown[]) {
      if (row === null || typeof row !== 'object') continue;
      const record = row as Record<string, unknown>;
      const tier = record['tier'];
      if (tier === null || typeof tier !== 'object') continue;
      const { type, size } = tier as { type?: unknown; size?: unknown };
      // Only context-length tiers move the price of a long prompt; a `tier`
      // of another kind (e.g. an audio band) is not a context cliff.
      if (type === 'context' && typeof size === 'number' && Number.isFinite(size) && size > 0) {
        rows.push({ size: Math.floor(size), rates: record });
      }
    }
  }
  const legacy = cost['context_over_200k'];
  if (typeof legacy === 'number') {
    rows.push({ size: LEGACY_TIER_SIZE, rates: { input: legacy } });
  } else if (legacy !== null && typeof legacy === 'object') {
    rows.push({ size: LEGACY_TIER_SIZE, rates: legacy as Record<string, unknown> });
  }
  return rows.sort((a, b) => a.size - b.size);
}

/**
 * Resolve the first price cliff of a model that is REACHABLE inside its own
 * context window. `maxContext` <= 0 means the window is unknown, in which case
 * every published boundary is treated as reachable (the compaction side bails
 * on an unknown window anyway; the viewer still gets an honest answer).
 *
 * A tier whose rates equal or undercut the base is not a cliff — several
 * catalogs publish a `context` tier purely to restate the same numbers, and
 * compacting for it would cost history for no savings.
 */
export function resolvePriceCliffTokens(
  cost: ModelsDevModel['cost'] | Record<string, unknown> | undefined,
  maxContext: number,
): ContextPriceCliff | null {
  if (cost === null || cost === undefined || typeof cost !== 'object') return null;
  const base = cost as Record<string, unknown>;
  const rows = contextTierRows(base);
  if (rows.length === 0) return null;

  const reachable = Number.isFinite(maxContext) && maxContext > 0 ? maxContext : Infinity;
  for (const row of rows) {
    if (row.size < MIN_CLIFF_TOKENS || row.size >= reachable) continue;
    let best: ContextPriceCliff | null = null;
    for (const [key, field] of CLIFF_FIELDS) {
      const baseRate = finiteRate(base[key]);
      const cliffRate = finiteRate(row.rates[key]);
      if (!baseRate || cliffRate === undefined) continue;
      if (cliffRate <= baseRate * (1 + RATE_EPSILON)) continue;
      const multiplier = cliffRate / baseRate;
      if (!best || multiplier > best.multiplier) {
        best = { cliffTokens: row.size, multiplier, field, baseRate, cliffRate };
      }
    }
    if (best) return best;
  }
  return null;
}

/** Compaction fires this far under the cliff, so one turn cannot overshoot it. */
export const PRICE_CLIFF_TRIGGER_HEADROOM = 0.95;

/** Post-compaction target: land well under the cliff, not just under it. */
export const PRICE_CLIFF_TARGET_HEADROOM = 0.8;

/** Never let a malformed boundary compact a session out of its own headroom. */
const MIN_CLIFF_LOAD = 0.05;

export interface PriceCliffThresholds {
  warn: number;
  soft: number;
  hard: number;
}

export interface PriceCliffAdjustment {
  thresholds: PriceCliffThresholds;
  targetLoad: number;
  /** True when the cliff (not window fill) is what drives the ladder. */
  binding: boolean;
  /** The published boundary the cap came from, when binding. */
  cliffTokens?: number;
  /** Absolute token point the soft rung now fires at, when binding. */
  triggerTokens?: number;
}

/**
 * Cap a window-relative ladder at an absolute token cliff — the
 * `min(threshold x window, token_cap)` half of the Goose formula.
 *
 * Only the two rungs that trigger a compaction (warn/soft) are pulled down;
 * `hard` stays the overflow-safety line, because the cliff is a money boundary,
 * not a capacity one — a provider that bills 2x is still accepting the request.
 * The post-compaction target is capped too: without that, compaction fires at
 * the cliff and immediately re-crosses it on the next turn.
 */
export function adjustLadderForPriceCliff(
  input: PriceCliffThresholds & { targetLoad: number },
  availableInputTokens: number,
  cliffTokens: number | undefined,
): PriceCliffAdjustment {
  const passthrough: PriceCliffAdjustment = {
    thresholds: { warn: input.warn, soft: input.soft, hard: input.hard },
    targetLoad: input.targetLoad,
    binding: false,
  };
  if (
    cliffTokens === undefined ||
    !Number.isFinite(cliffTokens) ||
    cliffTokens < MIN_CLIFF_TOKENS ||
    !Number.isFinite(availableInputTokens) ||
    availableInputTokens <= 0
  ) {
    return passthrough;
  }
  const cliffLoad = cliffTokens / availableInputTokens;
  if (cliffLoad >= input.soft) return passthrough;

  const soft = Math.max(MIN_CLIFF_LOAD, cliffLoad * PRICE_CLIFF_TRIGGER_HEADROOM);
  const warn = Math.min(input.warn, soft);
  const hard = Math.max(input.hard, soft);
  const targetLoad = Math.max(
    MIN_CLIFF_LOAD * 0.5,
    Math.min(input.targetLoad, cliffLoad * PRICE_CLIFF_TARGET_HEADROOM),
  );
  return {
    thresholds: { warn, soft, hard },
    targetLoad,
    binding: true,
    // The boundary itself, not just the trigger derived from it: reporters and
    // the Session Story timeline need to say "capped AT 200K", and this field
    // is declared for exactly that. Leaving it unset made the contract a lie.
    cliffTokens,
    triggerTokens: Math.floor(soft * availableInputTokens),
  };
}

/**
 * Resolve the active model's cliff from the models.dev catalog. Best-effort by
 * contract: a registry miss, a network failure, or a model the catalog does not
 * list must never block boot or a model switch, so every failure path returns
 * `null` (no cliff) instead of throwing.
 *
 * Hosts pass the CATALOG provider id (aliases/OAuth families resolve through
 * `catalogProviderIdFor` / the sibling map they already own); core stays free
 * of any registry, config, or provider dependency.
 */
export async function resolvePriceCliffFromCatalog(
  getModel: (providerId: string, modelId: string) => Promise<{ cost?: unknown } | undefined>,
  catalogProviderId: string,
  modelId: string,
  maxContext: number,
): Promise<ContextPriceCliff | null> {
  try {
    const model = await getModel(catalogProviderId, modelId);
    return resolvePriceCliffTokens(model?.cost as ModelsDevModel['cost'], maxContext);
  } catch {
    return null;
  }
}

/** The shape stored under {@link CONTEXT_PRICE_CLIFF_META}. */
export interface ContextPriceCliffMeta {
  cliffTokens: number;
  multiplier?: number;
  field?: PriceCliffField;
  baseRate?: number;
  cliffRate?: number;
  /**
   * `provider/model` the cliff was resolved for. A catalog-resolved cliff is
   * route-scoped: after a model switch the new model may be free, or priced
   * differently, so a stale boundary must not cap the new route's window.
   * Absent = a user-set absolute cap, which is route-independent on purpose
   * (it survives a switch to an unpublishing model).
   */
  routeKey?: string;
}

/**
 * Normalize whatever a host published under the meta key into a cliff. Accepts
 * the rich object or a bare number; a stale or hand-edited value must never be
 * read as "compact at 0 tokens".
 */
export function readPriceCliffMeta(value: unknown): ContextPriceCliffMeta | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= MIN_CLIFF_TOKENS
      ? { cliffTokens: Math.floor(value) }
      : undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const cliffTokens = record['cliffTokens'];
  if (typeof cliffTokens !== 'number' || !Number.isFinite(cliffTokens) || cliffTokens < 0) {
    return undefined;
  }
  if (cliffTokens < MIN_CLIFF_TOKENS) return undefined;
  return {
    cliffTokens: Math.floor(cliffTokens),
    ...(typeof record['multiplier'] === 'number' ? { multiplier: record['multiplier'] } : {}),
    ...(typeof record['field'] === 'string' ? { field: record['field'] as PriceCliffField } : {}),
    ...(typeof record['baseRate'] === 'number' ? { baseRate: record['baseRate'] } : {}),
    ...(typeof record['cliffRate'] === 'number' ? { cliffRate: record['cliffRate'] } : {}),
    ...(typeof record['routeKey'] === 'string' ? { routeKey: record['routeKey'] } : {}),
  };
}

/**
 * The cliff that applies to THIS route, with its published rates — the display
 * form of {@link readPriceCliffTokens}. A catalog cliff stamped for another
 * route (the model changed and the host has not re-resolved yet) is absent, so
 * no surface can render a cap the engine is not honoring.
 */
export function readPriceCliffForRoute(
  meta: Record<string, unknown> | undefined,
  routeKey: string,
): ContextPriceCliffMeta | undefined {
  const parsed = readPriceCliffMeta(meta?.[CONTEXT_PRICE_CLIFF_META]);
  if (!parsed) return undefined;
  if (parsed.routeKey && parsed.routeKey !== routeKey) return undefined;
  return parsed;
}

/**
 * The cliff token count that applies to THIS route, or undefined for "no cap".
 * A catalog cliff carrying another route's key is ignored until the host
 * re-resolves it for the live model.
 */
export function readPriceCliffTokens(
  meta: Record<string, unknown> | undefined,
  routeKey: string,
): number | undefined {
  return readPriceCliffForRoute(meta, routeKey)?.cliffTokens;
}

/**
 * The route identity a cliff was resolved for. Both the publishing hosts and
 * the compaction middleware build it through this helper, so a cliff can never
 * be discarded by a format disagreement between the two sides.
 */
export function priceCliffRouteKey(
  providerId: string | undefined,
  modelId: string | undefined,
): string {
  return `${providerId ?? 'unknown'}/${modelId ?? ''}`;
}

/**
 * The route identity the compaction ladder will read the cliff back under.
 *
 * Every publisher MUST derive its key through this helper from the SAME live
 * context the middleware receives — never from config-level values, which can
 * name an alias provider or a default model that differs from the route in
 * flight. A key built from the wrong source is not an error: the reader treats
 * it as "another route's cliff" and drops the cap silently, disabling the whole
 * protection for that session.
 */
export function priceCliffRouteForContext(ctx: {
  provider?: { id?: string } | undefined;
  model?: string | undefined;
}): string {
  return priceCliffRouteKey(ctx.provider?.id, ctx.model);
}

/**
 * Publish (or clear) the resolved cliff on a session's meta. Hosts call this on
 * boot, on every model switch, and after a catalog refresh — the middleware
 * reads the meta and owns no catalog dependency. Pass `null` to clear, which is
 * what "pricing cliff protection off" and "this model has no published cliff"
 * both mean.
 */
export function writePriceCliffMeta(
  meta: Record<string, unknown>,
  cliff: ContextPriceCliff | ContextPriceCliffMeta | null | undefined,
  routeKey?: string,
): void {
  if (!cliff) {
    delete meta[CONTEXT_PRICE_CLIFF_META];
    return;
  }
  const rich = cliff as ContextPriceCliff & ContextPriceCliffMeta;
  meta[CONTEXT_PRICE_CLIFF_META] = {
    cliffTokens: rich.cliffTokens,
    ...(rich.multiplier !== undefined ? { multiplier: rich.multiplier } : {}),
    ...(rich.field !== undefined ? { field: rich.field } : {}),
    ...(rich.baseRate !== undefined ? { baseRate: rich.baseRate } : {}),
    ...(rich.cliffRate !== undefined ? { cliffRate: rich.cliffRate } : {}),
    ...(routeKey ? { routeKey } : {}),
  } satisfies ContextPriceCliffMeta;
}
