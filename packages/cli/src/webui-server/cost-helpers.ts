// PR 2 of Issue #30 (webui-server 8-PR refactor):
// cost computation helpers, inlined from
// `@wrongstack/webui/server/usage-cost.ts`.
//
// Why this split:
//
//   - The helpers are pure functions over `CostRates` and
//     `TokenUsage` interfaces. They have no closure
//     state, no side effects, and no module-level
//     dependencies. They were the easiest extraction after
//     the `Logger` shim and they are also the most
//     directly unit-testable: every input combination has
//     a deterministic output.
//
//   - The two implementations (`getCostRates` here, the
//     same-named helper in `@wrongstack/webui/server`)
//     must not drift apart. The plan body of Issue #30
//     calls this out explicitly: "Phase 2 of the refactor
//     plan continues this pattern for the rest of the
//     file." Lifting the helpers into a CLI-owned module
//     makes the duplication *visible*: if a future
//     contribution updates one copy and not the other, the
//     diff will show two distinct call sites and the
//     review will catch it.
//
//   - `webui-server.ts` loses 25 lines of arithmetic
//     noise and gains a 4-line import. The cost-rates
//     logic is now testable in isolation: pin the default
//     zero rate, pin the cache-read branch, pin the
//     per-million scaling. None of these were testable
//     while the helpers were buried between L137 and
//     L180 of `webui-server.ts`.
//
// What is *not* in this file:
//
//   - The `TokenUsage` / `CostRates` interfaces are also
//     defined by `@wrongstack/webui/server`. We duplicate
//     the shape here intentionally so the CLI can evolve
//     the helpers without round-tripping every change
//     through the webui package. The plan body's "the two
//     implementations are no longer drifting apart"
//     framing applies here: same name, same shape, two
//     copies. If a future change makes them genuinely
//     divergent, the type system will surface it at the
//     WS handler that uses both.

/** Per-1,000,000-token pricing, normalized to numbers (0 when unpriced). */
export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
}

/** Token counts for a turn/session. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number | undefined;
}

/**
 * Extract per-million-token pricing from a model record. Returns
 * zeros when the model is null/undefined, has no `cost` field, or
 * is missing individual rate fields. The `cache_read` snake_case
 * is preserved as-is from the upstream schema — renaming to
 * `cacheRead` happens at the boundary.
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
 * Compute the per-turn cost in USD for the given token usage
 * and per-million rates. The cache-read branch is optional:
 * when `usage.cacheRead` is undefined it contributes 0 to the
 * total. The final value is the per-million-scaled sum, not
 * the per-token cost.
 */
export function computeUsageCost(usage: TokenUsage, rates: CostRates): number {
  return (
    (usage.input * rates.input +
      usage.output * rates.output +
      (usage.cacheRead ?? 0) * rates.cacheRead) /
    1_000_000
  );
}
