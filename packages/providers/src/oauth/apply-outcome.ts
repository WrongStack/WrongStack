import type { ProviderAuthOutcome, ProviderConfig } from '@wrongstack/core/types';

export interface ApplyProviderAuthOutcomeOptions {
  targetProviderId?: string | undefined;
}

/** Apply a login result without performing file IO or exposing the secret vault. */
export function applyProviderAuthOutcome(
  providers: Record<string, ProviderConfig>,
  outcome: ProviderAuthOutcome,
  opts: ApplyProviderAuthOutcomeOptions = {},
): { providerId: string; provider: ProviderConfig } {
  const providerId = opts.targetProviderId?.trim() || outcome.providerId;
  const existing = providers[providerId];
  const provider: ProviderConfig = existing ? { ...existing } : { type: providerId };
  provider.family = outcome.family;
  if (!provider.baseUrl && outcome.baseUrl) provider.baseUrl = outcome.baseUrl;
  if (outcome.models.length > 0) provider.models = [...outcome.models];
  const keys = [...(provider.apiKeys ?? [])].filter(
    (entry) => entry.label !== outcome.credential.label,
  );
  keys.push({ ...outcome.credential });
  provider.apiKeys = keys;
  provider.activeKey = outcome.credential.label;
  // New writes use apiKeys only; never leave a plaintext legacy key beside it.
  provider.apiKey = undefined;
  providers[providerId] = provider;
  return { providerId, provider };
}
