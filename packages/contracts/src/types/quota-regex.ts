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

export const QUOTA_EXHAUSTED_RE =
  /(?:insufficient|exhausted|depleted|exceeded|no|not enough)[-_\s]*(?:quota|credit|balance)|(?:quota|credit|balance)(?:\s+(?:has|have))?(?:\s+been)?[-_\s]*(?:exhausted|depleted|exceeded|insufficient)|billing[_\s-]*(?:hard[_\s-]*)?limit|payment required|spending limit|plan limit|(?:usage|credit)[-_\s]*(?:quota|limit)(?![-_\w])|usage[-_\s]*(?:limit|quota)[-_\s]*(?:reached|exceeded|for)/i;

export const ROUTE_SCOPED_QUOTA_RE =
  /\b(?:for|on)\s+(?:(?:this|the)\s+)?(?:route|model)\b|\b(?:route|model)(?:[-_\s]+[\w.-]+)?[-_\s]*(?:quota|limit)\b|\b(?:quota|limit).{0,24}\b(?:for|on)\s+(?:(?:this|the)\s+)?(?:route|model)\b/i;
