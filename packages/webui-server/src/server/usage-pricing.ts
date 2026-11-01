/** Additive estimate detail. Legacy stats.cost remains unchanged for older clients. */
export function usagePricing(
  usage: {
    input: number;
    output: number;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    /** The part of `cacheWrite` the provider reported as written for 5 minutes / 1 hour. */
    cacheWrite5m?: number | undefined;
    cacheWrite1h?: number | undefined;
  },
  model: unknown,
  customModelsDev?: unknown,
) {
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const cost = { ...object(object(model)['cost']), ...object(object(customModelsDev)['cost']) };
  const rate = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const input = rate(cost['input']);
  const cacheWriteRate = cost['cache_write'] === undefined ? input : rate(cost['cache_write']);
  const categories = [
    ['input', usage.input, rate(cost['input']), 'catalog'],
    ['output', usage.output, rate(cost['output']), 'catalog'],
    [
      'cache-read',
      usage.cacheRead ?? 0,
      cost['cache_read'] === undefined ? input : rate(cost['cache_read']),
      cost['cache_read'] === undefined ? 'input-fallback' : 'catalog',
    ],
    [
      'cache-write',
      usage.cacheWrite ?? 0,
      lifetimeRate(usage, cost, input, cacheWriteRate, rate),
      cost['cache_write'] === undefined ? 'input-fallback' : 'catalog',
    ],
  ] as const;
  const parts = categories.map(([kind, rawTokens, rateUsdPerMillion, source]) => {
    const tokens = Number.isFinite(rawTokens) && rawTokens >= 0 ? rawTokens : 0;
    return {
      kind,
      tokens,
      rateUsdPerMillion,
      rateSource: rateUsdPerMillion === null ? 'unavailable' : source,
      estimateUsd: rateUsdPerMillion === null ? null : (tokens * rateUsdPerMillion) / 1_000_000,
    };
  });
  const known = parts.filter((part) => part.rateUsdPerMillion !== null).length;
  const knownCostUsd = known ? parts.reduce((sum, part) => sum + (part.estimateUsd ?? 0), 0) : null;
  return {
    currency: 'USD',
    basis: 'current-model-aggregate-rates',
    coverage: known === 4 ? 'complete' : known ? 'partial' : 'unavailable',
    estimateUsd:
      known && parts.every((part) => part.tokens === 0 || part.rateUsdPerMillion !== null)
        ? knownCostUsd
        : null,
    knownCostUsd,
    parts,
  };
}

/**
 * The cache-write rate, blended by how long the provider said it keeps each write: a 5-minute
 * write at the catalog's 5-minute price (else its cache-write price), a 1-hour write at its
 * 1-hour price (else twice the input price), as the core token counter prices them. Writes the
 * provider did not split keep the cache-write price. One rate keeps the four-part detail.
 */
function lifetimeRate(
  usage: {
    cacheWrite?: number | undefined;
    cacheWrite5m?: number | undefined;
    cacheWrite1h?: number | undefined;
  },
  cost: Record<string, unknown>,
  input: number | null,
  cacheWriteRate: number | null,
  rate: (value: unknown) => number | null,
): number | null {
  const total = usage.cacheWrite ?? 0;
  const write5m = Math.max(0, usage.cacheWrite5m ?? 0);
  const write1h = Math.max(0, usage.cacheWrite1h ?? 0);
  if (!(total > 0) || (!write5m && !write1h)) return cacheWriteRate;
  const rate5m =
    cost['cache_write_5m'] === undefined ? cacheWriteRate : rate(cost['cache_write_5m']);
  const rate1h =
    cost['cache_write_1h'] === undefined
      ? input === null
        ? null
        : input * 2
      : rate(cost['cache_write_1h']);
  const unsplit = Math.max(0, total - write5m - write1h);
  if (
    (write5m && rate5m === null) ||
    (write1h && rate1h === null) ||
    (unsplit && cacheWriteRate === null)
  )
    return null;
  return (
    (write5m * (rate5m ?? 0) + write1h * (rate1h ?? 0) + unsplit * (cacheWriteRate ?? 0)) / total
  );
}
