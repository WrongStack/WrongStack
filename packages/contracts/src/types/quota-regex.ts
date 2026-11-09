/**
 * Shared regex literals for classifying provider error messages as
 * account/plan-level quota exhaustion vs. per-request rate limiting.
 *
 * ## Why this module exists
 *
 * The same regex used by `classifyProviderError` (`packages/core/src/types/provider.ts`)
 * is also used by `isQuotaExhausted` in `provider-status-tracker.ts`. Hand-maintained
 * duplicates of a regex literal that mutates every release cycle (new provider
 * message shapes) silently drift — the two paths classify messages
 * inconsistently. Centralising the literal here makes a single edit take
 * effect on every caller.
 *
 * Callers MUST NOT re-declare these regexes locally. Import from this module.
 *
 * @module types/quota-regex
 */

/**
 * The last three alternatives are daily caps (#424): "daily token limit",
 * "tokens per day (TPD)", "limit exceeded for today". A daily cap does not
 * clear within a burst cooldown, and when it covers every key of an account it
 * covers every model, so reading it as `rate_limit` sent the fallback chain
 * through each sibling model. Per-minute and per-hour wording stays transient,
 * and the camel-case metric names some providers list (`RequestsPerDay…`) do
 * not match: they appear beside burst violations too.
 */
export const QUOTA_EXHAUSTED_RE =
  /(?:insufficient|exhausted|depleted|exceeded|no|not enough)[-_\s]*(?:quota|credit|balance)|(?:quota|credit|balance)(?:\s+(?:has|have))?(?:\s+been)?[-_\s]*(?:exhausted|depleted|exceeded|insufficient)|billing[_\s-]*(?:hard[_\s-]*)?limit|payment required|spending limit|plan limit|(?:usage|credit)[-_\s]*(?:quota|limit)(?![-_\w])|usage[-_\s]*(?:limit|quota)[-_\s]*(?:reached|exceeded|for)|\b(?:daily|per[-_\s]?day)[-_\s]+(?:(?:token|request|call|usage)s?[-_\s]+)?(?:limit|quota|cap)\b|\b(?:tokens?|requests?|calls?)[-_\s]+per[-_\s]+day\b|\b(?:limit|quota)[-_\s]+(?:has\s+been\s+)?(?:exceeded|reached)[-_\s]+for[-_\s]+today\b/i;

export const ROUTE_SCOPED_QUOTA_RE =
  /\b(?:for|on)\s+(?:(?:this|the)\s+)?(?:route|model)\b|\b(?:route|model)(?:[-_\s]+[\w.-]+)?[-_\s]*(?:quota|limit)\b|\b(?:quota|limit).{0,24}\b(?:for|on)\s+(?:(?:this|the)\s+)?(?:route|model)\b/i;
