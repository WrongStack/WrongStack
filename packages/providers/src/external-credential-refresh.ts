/**
 * OAuth accounts renewed by someone else.
 *
 * A host can hold an OAuth credential whose refresh token lives elsewhere — an
 * HQ key vault signs in centrally, keeps the refresh token, and hands machines
 * only access tokens. Such an entry is `authMethod: 'oauth'` with a `source`
 * and no `refreshToken`. Left alone, every refresh coordinator treats a missing
 * refresh key as "nothing to renew" and keeps sending the expired token until
 * the provider answers 401.
 *
 * The host installs one renewer ({@link setExternalCredentialRefresher});
 * `buildProvider` then gives such an entry an in-memory placeholder refresh key
 * (so the coordinator renews on schedule) and a refresher that asks the host.
 * The placeholder never reaches the provider's token endpoint and is never
 * persisted: the host's renewer returns a credential without it.
 */
import type { ProviderApiKey } from '@wrongstack/contracts/types';

export type ExternalCredentialRefresher = (
  providerId: string,
  credential: ProviderApiKey,
  signal?: AbortSignal,
) => Promise<ProviderApiKey>;

const PLACEHOLDER_PREFIX = 'external-renewal:';

let refresher: ExternalCredentialRefresher | undefined;

export function setExternalCredentialRefresher(fn: ExternalCredentialRefresher | undefined): void {
  refresher = fn;
}

/**
 * Whether `entry` is an OAuth account the installed host renewer refreshes.
 * A memory-only lease is not: the host re-leases it, and a renewal here would
 * hand the new token to the refresh transaction, which writes it to disk.
 */
export function isExternallyRenewed(entry: ProviderApiKey | undefined): boolean {
  return (
    refresher !== undefined &&
    entry?.authMethod === 'oauth' &&
    !entry.refreshToken &&
    entry.source !== undefined &&
    entry.source.lease !== true
  );
}

/** The in-memory refresh key standing in for the one the host holds. */
export function externalRefreshPlaceholder(entry: ProviderApiKey): string {
  return `${PLACEHOLDER_PREFIX}${entry.source?.keyId ?? entry.label}`;
}

export function isExternalRefreshPlaceholder(value: string | undefined): boolean {
  return value?.startsWith(PLACEHOLDER_PREFIX) === true;
}

/** Ask the host for a fresh credential. The result never carries the placeholder. */
export async function renewExternally(
  providerId: string,
  credential: ProviderApiKey,
  signal?: AbortSignal,
): Promise<ProviderApiKey> {
  if (!refresher) throw new Error(`${providerId}: no host renews this account.`);
  const { refreshToken, ...rest } = credential;
  const renewed = await refresher(
    providerId,
    isExternalRefreshPlaceholder(refreshToken) ? rest : credential,
    signal,
  );
  if (!renewed.apiKey) throw new Error(`${providerId}: the host returned no access token.`);
  return renewed;
}
