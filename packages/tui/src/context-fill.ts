/**
 * Context-window fill resolution for the statusline `ctx` chip.
 *
 * The chip and the `/context` panel MUST agree. They diverged because the panel
 * reads the agent loop's own `ctx.pct` measurement (`state.leader.ctxTokens`)
 * while the chip rolled its own number from the provider's reported usage, and
 * fell back to the *cumulative* session total when the provider under-reported
 * prompt tokens. A cumulative total is a session aggregate — it climbs into the
 * millions and cannot be compared against a per-request ceiling, so clamping it
 * pegged the bar at a false `1.0M/1.0M` (100%). See
 * [[statusline-vs-context-token-source]].
 *
 * This module is the single place that decides *which* number the chip shows.
 * It is pure so the precedence can be tested without rendering the App.
 */

interface ContextFillInputs {
  /**
   * Tokens reported by the agent loop's `ctx.pct` event
   * (`state.leader.ctxTokens`). Authoritative: it anchors on the provider's real
   * prompt-token count and adds an estimate of messages appended since, against
   * the live per-model ceiling. This is the exact number `/context` displays.
   */
  loopReportedTokens?: number | undefined;
  /**
   * `tokenCounter.currentRequestTokens()` summed (input + cacheRead +
   * cacheWrite). Only meaningful for the model that produced it.
   */
  perRequestTokens: number;
  /** `getContextBreakdown(ctx).total` — local tokenizer estimate. */
  localEstimate?: number | undefined;
  /** Live per-model context ceiling. */
  maxContext: number;
}

type ContextFillSource = 'loop' | 'provider' | 'local' | 'none';

interface ContextFillResult {
  /** Tokens to display as "used". Always `<= maxContext` (and `>= 0`). */
  used: number;
  /**
   * True when neither the loop nor the provider produced a usable number, so
   * the caller should compute `getContextBreakdown` and pass it back in as
   * `localEstimate`.
   */
  needsLocalEstimate: boolean;
  source: ContextFillSource;
}

/**
 * Pick the context-fill numerator, most trustworthy source first.
 *
 * 1. `loopReportedTokens` — same value as `/context`, so the two surfaces match.
 * 2. `perRequestTokens`, but only when it is a *valid* per-request measure: a
 *    real one cannot exceed its own ceiling. A value above `maxContext` is
 *    stale (the model switched to a smaller window and the snapshot still
 *    belongs to the old one) or mis-parsed, and is rejected rather than clamped
 *    to a misleading 100%.
 * 3. `localEstimate`.
 *
 * The cumulative session total is deliberately not an input — it is never a
 * valid answer to "how full is the context window?".
 */
export function resolveContextFill(inputs: ContextFillInputs): ContextFillResult {
  const { loopReportedTokens, perRequestTokens, localEstimate, maxContext } = inputs;
  const ceiling = maxContext > 0 ? maxContext : Number.POSITIVE_INFINITY;
  const clamp = (n: number): number => Math.max(0, Math.min(n, ceiling));

  if (typeof loopReportedTokens === 'number' && loopReportedTokens > 0) {
    return { used: clamp(loopReportedTokens), needsLocalEstimate: false, source: 'loop' };
  }

  if (perRequestTokens > 0 && perRequestTokens <= ceiling) {
    return { used: clamp(perRequestTokens), needsLocalEstimate: false, source: 'provider' };
  }

  if (typeof localEstimate === 'number' && localEstimate > 0) {
    return { used: clamp(localEstimate), needsLocalEstimate: true, source: 'local' };
  }

  return { used: 0, needsLocalEstimate: true, source: 'none' };
}
