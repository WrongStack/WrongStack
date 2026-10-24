/** The `ProviderErrorKind`s a code can decide; a literal subset so this file imports nothing. */
type CodeKind = 'quota_exhausted' | 'overloaded' | 'rate_limit' | 'context_overflow';

/**
 * Provider error codes whose meaning is unambiguous, consulted by
 * `classifyProviderError` ahead of status and prose. These are OpenAI's
 * (Responses API + ChatGPT backend), mapped as the official Codex client maps
 * them: a 429 `usage_not_included` would otherwise be retried forever as a
 * rate limit, and a 503 `server_is_overloaded` retried as a plain 5xx.
 *
 * Deliberately absent:
 * - policy codes (`cyber_policy`, `bio_policy`, `invalid_prompt`): they stay
 *   `invalid_request`, because `content_filter` would let the reroute strategy
 *   route a safety refusal to a sibling model;
 * - billing codes (`insufficient_quota`, `*_spend_limit_exceeded`, …): quota
 *   is decided from the structured message/type only (see the quota comment
 *   in `classifyProviderError`), and a code-only match would reopen the
 *   burst-429 → 15-minute quarantine regression that rule exists to prevent.
 */
const KIND_BY_ERROR_CODE: Readonly<Record<string, CodeKind>> = {
  // ChatGPT backend: the plan does not include Codex at all. Retrying is
  // pointless; another provider may still serve the request.
  usage_not_included: 'quota_exhausted',
  // A documented per-app ChatGPT plan allowance, not a transient burst limit.
  subscription_sharing_usage_limit_exceeded: 'quota_exhausted',
  server_is_overloaded: 'overloaded',
  slow_down: 'rate_limit',
  context_length_exceeded: 'context_overflow',
};

export function kindFromErrorCode(code: string | undefined): CodeKind | undefined {
  return code !== undefined && Object.hasOwn(KIND_BY_ERROR_CODE, code)
    ? KIND_BY_ERROR_CODE[code]
    : undefined;
}

/**
 * OpenAI safety-classifier refusal codes. The request was understood and the
 * provider is healthy; a classifier judged the content. Such a refusal is
 * never retried (OpenAI may restrict an account that keeps tripping the
 * check) and is not a provider-health failure.
 */
const SAFETY_POLICY_CODES: ReadonlySet<string> = new Set([
  'cyber_policy',
  'bio_policy',
  'invalid_prompt',
]);

export function isSafetyPolicyCode(code: string | undefined): boolean {
  return code !== undefined && SAFETY_POLICY_CODES.has(code);
}
