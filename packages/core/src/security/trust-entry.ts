import type { TrustPolicy } from '@wrongstack/contracts/types/permission';
import type { Tool } from '@wrongstack/contracts/types/tool';

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

/** Old-name refusals survive renames; old-name grants never widen canonical access. */
export function mergeAliasDenials(
  entry: TrustPolicy[string] | undefined,
  tool: Tool,
  lookup: (name: string) => TrustPolicy[string] | undefined,
): TrustPolicy[string] | undefined {
  let result = entry;
  for (const alias of tool.aliases ?? []) {
    const old = lookup(alias);
    if (!old?.deny?.length && old?.denyPrivate !== true) continue;
    result = {
      ...result,
      deny: [...new Set([...(result?.deny ?? []), ...(old?.deny ?? [])])],
      ...(old?.denyPrivate === true ? { denyPrivate: true } : {}),
    };
  }
  return result;
}
