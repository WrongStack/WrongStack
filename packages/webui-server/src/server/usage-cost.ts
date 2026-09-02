/**
 * Token-usage cost math for the WebUI server.
 *
 * models.dev pricing is expressed in **dollars per 1,000,000 tokens**, and
 * providers omit the field entirely for free/unmetered plans. Both the
 * `session.start` payload (which ships the per-token rates to the client) and
 * `stats.get` (which reports an actual dollar figure) repeated the same
 * "read `model.cost.*` with a `?? 0` fallback, then divide by 1e6" logic
 * inline. Pulling it here keeps the rate normalization and the cost formula in
 * one tested place — a wrong field name or a missing `/ 1e6` silently produces
 * a plausible-but-wrong number, which is exactly what a unit test should pin.
 */

/** Per-1,000,000-token pricing, normalized to numbers (0 when unpriced). */
export interface CostRates {
  /** $ per 1M input tokens. */
  input: number;
  /** $ per 1M output tokens. */
  output: number;
  /** $ per 1M cache-read tokens. */
  cacheRead: number;
}

/** Token counts for a turn/session. `cacheRead` is optional (older counters). */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number | undefined;
}

/**
 * Normalize a models.dev model object's pricing into {@link CostRates}.
 * Missing model, missing `cost`, or missing individual fields all yield 0 —
 * free/unmetered plans report `$0` rather than crashing.
 */
export function getCostRates(model: unknown): CostRates {
  const cost = (
    model as
      | {
          cost?: {
            input?: number | undefined;
            output?: number | undefined;
            cache_read?: number | undefined;
          };
        }
      | null
      | undefined
  )?.cost;
  return {
    input: cost?.input ?? 0,
    output: cost?.output ?? 0,
    cacheRead: cost?.cache_read ?? 0,
  };
}

/**
 * Dollar cost of `usage` at the given per-1M-token `rates`. Returns 0 when all
 * rates are 0 (unpriced plan).
 */
export function computeUsageCost(usage: TokenUsage, rates: CostRates): number {
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      (usage.cacheRead ?? 0) * rates.cacheRead) /
    1_000_000
  );
}
