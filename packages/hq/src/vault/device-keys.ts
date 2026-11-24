/**
 * The provider-config key list helpers the device client needs, copied from
 * the CLI's `provider-config-utils.ts` (this package cannot import the CLI).
 * Keep the two in step: `writeKeysBack` clears the legacy plaintext `apiKey`
 * and repairs `activeKey`.
 */
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types/config';

/** The canonical `apiKeys[]` form of a provider, legacy `apiKey` migrated. Does not mutate. */
export function normalizeKeys(cfg: ProviderConfig): ProviderApiKey[] {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    return cfg.apiKeys.map((k) => ({ ...k }));
  }
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
    return [{ label: 'default', apiKey: cfg.apiKey, createdAt: '' }];
  }
  return [];
}

/** Write a key list back; never mirrors a plaintext key to the legacy `apiKey` field. */
export function writeKeysBack(cfg: ProviderConfig, keys: ProviderApiKey[]): void {
  if (keys.length === 0) {
    delete cfg.apiKeys;
    delete cfg.apiKey;
    delete cfg.activeKey;
    return;
  }
  cfg.apiKeys = keys;
  delete cfg.apiKey;
  if (!cfg.activeKey || !keys.some((k) => k.label === cfg.activeKey)) {
    cfg.activeKey = keys[0]!.label;
  }
}
