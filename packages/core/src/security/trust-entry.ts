import type { TrustPolicy } from '@wrongstack/contracts/types/permission';

/**
 * Combine an exact-name trust entry with the wildcard entry that also matched.
 *
 * Deny is the union of both levels — a narrow "always allow" must never be able
 * to drop a broad guardrail. Everything permissive (allow / auto / trustWorkdir
 * / denyPrivate) comes from the more specific entry when it says anything, so
 * exact-name rules still win where they are meant to.
 */
export function mergeTrustEntries(
  exact: TrustPolicy[string] | undefined,
  wildcard: TrustPolicy[string] | undefined,
): TrustPolicy[string] | undefined {
  if (!exact) return wildcard;
  if (!wildcard) return exact;

  const deny = [...(wildcard.deny ?? []), ...(exact.deny ?? [])];
  const merged: TrustPolicy[string] = {
    ...wildcard,
    ...exact,
  };
  if (deny.length > 0) merged.deny = [...new Set(deny)];
  return merged;
}
