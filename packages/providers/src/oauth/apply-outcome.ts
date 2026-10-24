import type { ProviderAuthOutcome, ProviderConfig } from '@wrongstack/contracts/types';
import { authProfileAliasError } from '../provider-config-state.js';

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
  const aliasError = authProfileAliasError(providerId);
  if (aliasError) throw new Error(aliasError);
  const existing = providers[providerId];
  if (
    existing &&
    ((existing.type && existing.type !== providerId && existing.type !== outcome.providerId) ||
      (existing.family && existing.family !== outcome.family))
  ) {
    throw new Error(
      `Auth profile "${providerId}" belongs to another provider. Choose a different alias.`,
    );
  }
  const provider: ProviderConfig = existing ? { ...existing } : { type: outcome.providerId };
  if (!provider.type || provider.type === providerId) provider.type = outcome.providerId;
  provider.family = outcome.family;
  if (!provider.baseUrl && outcome.baseUrl) provider.baseUrl = outcome.baseUrl;
  if (outcome.credential.authMethod === 'oauth' || outcome.models.length > 0)
    provider.models = [...outcome.models];
  const savedKeys = provider.apiKeys?.length
    ? provider.apiKeys
    : provider.apiKey
      ? [{ label: 'default', apiKey: provider.apiKey, createdAt: new Date().toISOString() }]
      : [];
  const keys = [...savedKeys].filter((entry) => entry.label !== outcome.credential.label);
  keys.push({ ...outcome.credential });
  provider.apiKeys = keys;
  provider.activeKey = outcome.credential.label;
  // New writes use apiKeys only; never leave a plaintext legacy key beside it.
  provider.apiKey = undefined;
  providers[providerId] = provider;
  return { providerId, provider };
}
