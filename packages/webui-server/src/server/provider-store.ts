import { expectDefined } from '@wrongstack/core/utils';
import * as fs from 'node:fs/promises';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import { atomicWrite } from '@wrongstack/core/utils';
import type { DefaultSecretVault } from '@wrongstack/core/security';
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/core/types';
// One masking policy per package. This file used to carry a byte-identical
// private copy of `maskedKey`, so a change to how much of a secret is shown
// had to be made twice to take effect on every surface.
import { maskedKey } from './provider-keys.js';
interface ProviderStoreDeps {
  /** Active profile config path. */
  profileConfigPath: string;
  vault: DefaultSecretVault;
}

/**
 * Serializes concurrent config writes to prevent races between model.switch
 * and key.add/key.update handlers that both mutate the profile config.
 */
export function createConfigWriteLock() {
  let lock: Promise<void> = Promise.resolve();
  return {
    get current() { return lock; },
    acquire() {
      const prev = lock;
      let release: () => void = () => undefined;
      lock = new Promise<void>((resolve) => { release = resolve; });
      return { prev, release };
    },
  };
}

export interface ProviderStore {
  load(): Promise<Record<string, ProviderConfig>>;
  save(providers: Record<string, ProviderConfig>): Promise<void>;
  normalizeKeys(cfg: ProviderConfig): ProviderApiKey[];
  writeKeysBack(cfg: ProviderConfig, keys: ProviderApiKey[]): void;
  maskedKey(key: string | undefined): string;
}

export function createProviderStore(deps: ProviderStoreDeps): ProviderStore {
  const { profileConfigPath, vault } = deps;
  const configWriteLock = createConfigWriteLock();

  async function loadSavedProviders(): Promise<Record<string, ProviderConfig>> {
    try {
      const raw = await fs.readFile(profileConfigPath, 'utf8');
      const parsed = JSON.parse(raw) as { providers?: Record<string, ProviderConfig> };
      if (!parsed.providers) return {};
      return decryptConfigSecrets(parsed.providers, vault);
    } catch {
      return {};
    }
  }

  async function saveProviders(providers: Record<string, ProviderConfig>): Promise<void> {
    const { prev, release } = configWriteLock.acquire();
    try {
      await prev;
      let parsed: Record<string, unknown>;
      try {
        const raw = await fs.readFile(profileConfigPath, 'utf8');
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      parsed['providers'] = providers;
      const encrypted = encryptConfigSecrets(parsed, vault);
      await atomicWrite(profileConfigPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
    } finally {
      release();
    }
  }

  function normalizeKeys(cfg: ProviderConfig): ProviderApiKey[] {
    if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
      return cfg.apiKeys.map((k) => ({ ...k }));
    }
    if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
      return [{ label: 'default', apiKey: cfg.apiKey, createdAt: '' }];
    }
    return [];
  }

  function writeKeysBack(cfg: ProviderConfig, keys: ProviderApiKey[]): void {
    if (keys.length === 0) {
      delete cfg.apiKeys;
      delete cfg.apiKey;
      delete cfg.activeKey;
      return;
    }
    cfg.apiKeys = keys;
    const active = keys.find((k) => k.label === cfg.activeKey) ?? expectDefined(keys[0]);
    // Do NOT mirror plaintext to cfg.apiKey — cleared to prevent serialization leaks.
    delete cfg.apiKey;
    if (!cfg.activeKey || !keys.some((k) => k.label === cfg.activeKey)) {
      cfg.activeKey = active.label;
    }
  }

  return {
    load: loadSavedProviders,
    save: saveProviders,
    normalizeKeys,
    writeKeysBack,
    maskedKey,
  };
}
