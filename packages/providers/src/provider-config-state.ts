import { parseModelRef } from '@wrongstack/core/agent';

/**
 * Provider ids the host owns: `acp` (an ACP agent such as Claude Code as
 * leader or worker) and `wrongforge` (the machine's WrongForge). They route
 * to built-in runners, not to a `providers.<id>` entry, so a user profile
 * with one of these names would shadow the system provider in the picker and
 * in `delegate({ provider })`. Mirrors core's `EXTERNAL_AGENT_PROVIDERS`
 * (kept as a literal so this package does not pull in coordination code).
 */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(['acp', 'wrongforge']);

/** True for a system-owned provider id, compared case-insensitively. */
export function isReservedProviderId(id: string): boolean {
  return RESERVED_PROVIDER_IDS.has(id.trim().toLowerCase());
}

export function authProfileAliasError(alias: string): string | undefined {
  if (isReservedProviderId(alias)) {
    return `"${alias.trim()}" is a reserved system provider name (${[...RESERVED_PROVIDER_IDS].join(', ')}). Choose another provider id.`;
  }
  if (
    !alias.trim() ||
    alias !== alias.trim() ||
    alias.length > 256 ||
    /[/\u0000-\u001f]/.test(alias) ||
    ['__proto__', 'prototype', 'constructor'].includes(alias) ||
    Object.hasOwn(Object.prototype, alias)
  ) {
    return 'Auth profile alias must contain 1–256 characters, no slash or control characters, and cannot be a reserved config key.';
  }
  return undefined;
}

/** Preserve unrelated edits made after a UI loaded its provider snapshot. */
export class ProviderConfigSnapshots {
  private readonly baselines = new WeakMap<
    Record<string, ProviderConfig>,
    Record<string, ProviderConfig>
  >();

  track(providers: Record<string, ProviderConfig>): Record<string, ProviderConfig> {
    this.baselines.set(providers, structuredClone(providers));
    return providers;
  }

  merge(
    current: Record<string, ProviderConfig>,
    next: Record<string, ProviderConfig>,
  ): Record<string, ProviderConfig> {
    const baseline = this.baselines.get(next);
    if (!baseline) return structuredClone(next);
    const merged = structuredClone(current);
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const id of new Set([...Object.keys(baseline), ...Object.keys(next)])) {
      if (equal(baseline[id], next[id])) continue;
      if (!equal(current[id], baseline[id]) && !equal(current[id], next[id])) {
        throw new Error(`Provider "${id}" changed in another interface. Refresh and try again.`);
      }
      if (Object.hasOwn(next, id))
        Object.defineProperty(merged, id, {
          value: structuredClone(next[id]),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else delete merged[id];
    }
    return merged;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProviderModelRef(value: unknown, providerId: string): boolean {
  return typeof value === 'string' && parseModelRef(value).provider === providerId;
}

/**
 * Remove references to a deleted provider from fallback routing. Empty named
 * profiles are removed, then every selector pointing at one of those removed
 * profiles is cleared so a live reload never inherits a dangling chain.
 */
export function removeProviderFallbackReferences(
  config: Record<string, unknown>,
  providerId: string,
): void {
  const removeModelRefs = (value: unknown): unknown[] | undefined =>
    Array.isArray(value) ? value.filter((ref) => !isProviderModelRef(ref, providerId)) : undefined;

  if (Array.isArray(config['fallbackModels'])) {
    config['fallbackModels'] = removeModelRefs(config['fallbackModels'])!;
  }
  if (
    typeof config['fallbackBridge'] === 'string' &&
    isProviderModelRef(config['fallbackBridge'], providerId)
  ) {
    delete config['fallbackBridge'];
  }
  if (Array.isArray(config['favoriteModels'])) {
    config['favoriteModels'] = removeModelRefs(config['favoriteModels'])!;
  }
  if (Array.isArray(config['disabledModels'])) {
    config['disabledModels'] = removeModelRefs(config['disabledModels'])!;
  }
  // `disabledProviders` holds bare provider ids (not model refs), so the
  // provider-level entry is dropped directly when its provider goes away.
  if (Array.isArray(config['disabledProviders'])) {
    config['disabledProviders'] = (config['disabledProviders'] as unknown[]).filter(
      (id) => typeof id !== 'string' || id.trim().toLowerCase() !== providerId.trim().toLowerCase(),
    );
  }
  if (isRecord(config['models'])) {
    for (const [modelId, definition] of Object.entries(config['models'])) {
      if (isRecord(definition) && definition['provider'] === providerId) {
        delete config['models'][modelId];
      }
    }
    if (Object.keys(config['models']).length === 0) delete config['models'];
  }

  const removedProfiles = new Set<string>();
  if (isRecord(config['fallbackProfiles'])) {
    const profiles = config['fallbackProfiles'];
    for (const [name, chain] of Object.entries(profiles)) {
      if (!Array.isArray(chain)) continue;
      const next = chain.filter((ref) => !isProviderModelRef(ref, providerId));
      if (next.length === 0) {
        delete profiles[name];
        removedProfiles.add(name);
      } else {
        profiles[name] = next;
      }
    }
    if (Object.keys(profiles).length === 0) delete config['fallbackProfiles'];
  }

  const clearRemovedProfile = (entry: Record<string, unknown>): void => {
    if (
      typeof entry['fallbackProfile'] === 'string' &&
      removedProfiles.has(entry['fallbackProfile'])
    ) {
      delete entry['fallbackProfile'];
    }
  };

  if (
    typeof config['fallbackProfile'] === 'string' &&
    removedProfiles.has(config['fallbackProfile'])
  ) {
    delete config['fallbackProfile'];
  }

  if (isRecord(config['modelMatrix'])) {
    for (const [role, value] of Object.entries(config['modelMatrix'])) {
      if (!isRecord(value)) continue;
      if (value['provider'] === providerId) {
        delete value['provider'];
        delete value['model'];
      }
      clearRemovedProfile(value);
      if (Object.keys(value).length === 0) delete config['modelMatrix'][role];
    }
    if (Object.keys(config['modelMatrix']).length === 0) delete config['modelMatrix'];
  }

  if (isRecord(config['modelTiers']) && isRecord(config['modelTiers']['levels'])) {
    const levels = config['modelTiers']['levels'];
    for (const level of Object.values(levels)) {
      if (!isRecord(level)) continue;
      if (level['provider'] === providerId) {
        delete level['provider'];
        delete level['model'];
      }
      clearRemovedProfile(level);
    }
  }

  if (isRecord(config['autonomy'])) {
    const autonomy = config['autonomy'];
    if (autonomy['refinerProvider'] === providerId) {
      delete autonomy['refinerProvider'];
      delete autonomy['refinerModel'];
    }
    if (isProviderModelRef(autonomy['enhanceFallbackModel'], providerId)) {
      delete autonomy['enhanceFallbackModel'];
    }
    if (
      typeof autonomy['refinerFallbackProfile'] === 'string' &&
      removedProfiles.has(autonomy['refinerFallbackProfile'])
    ) {
      delete autonomy['refinerFallbackProfile'];
    }
  }

  if (isRecord(config['brain'])) {
    const brain = config['brain'];
    if (Array.isArray(brain['models'])) {
      brain['models'] = brain['models'].filter(
        (entry) =>
          !isProviderModelRef(entry, providerId) &&
          !(isRecord(entry) && entry['provider'] === providerId),
      );
    }
    if (isRecord(brain['council'])) {
      const council = brain['council'];
      if (Array.isArray(council['voters'])) {
        council['voters'] = council['voters'].filter(
          (entry) =>
            !isProviderModelRef(entry, providerId) &&
            !(isRecord(entry) && entry['provider'] === providerId),
        );
      }
      if (
        isProviderModelRef(council['judge'], providerId) ||
        (isRecord(council['judge']) && council['judge']['provider'] === providerId)
      ) {
        delete council['judge'];
      }
    }
  }

  const councilProfiles =
    isRecord(config['tools']) && isRecord(config['tools']['council'])
      ? config['tools']['council']['profiles']
      : undefined;
  if (Array.isArray(councilProfiles)) {
    for (const profile of councilProfiles) {
      if (!isRecord(profile)) continue;
      for (const seat of Array.isArray(profile['seats']) ? profile['seats'] : []) {
        if (!isRecord(seat) || !isRecord(seat['target'])) continue;
        const target = seat['target'];
        if (target['providerId'] === providerId) {
          delete target['providerId'];
          delete target['model'];
        }
        if (Array.isArray(target['fallbackModels'])) {
          target['fallbackModels'] = removeModelRefs(target['fallbackModels'])!;
        }
        clearRemovedProfile(target);
        if (Object.keys(target).length === 0) delete seat['target'];
      }
      if (isRecord(profile['judge'])) {
        const judge = profile['judge'];
        if (judge['providerId'] === providerId) {
          delete judge['providerId'];
          delete judge['model'];
        }
        if (Array.isArray(judge['fallbackModels'])) {
          judge['fallbackModels'] = removeModelRefs(judge['fallbackModels'])!;
        }
        clearRemovedProfile(judge);
        if (Object.keys(judge).length === 0) delete profile['judge'];
      }
    }
  }
}

import type { ProviderConfig } from '@wrongstack/contracts/types';
import { isSetupProvider as isSetupProviderId } from './setup-provider.js';

function resolveActiveApiKey(cfg: ProviderConfig): string | undefined {
  if (cfg.apiKeys?.length)
    return (cfg.apiKeys.find((key) => key.label === cfg.activeKey) ?? cfg.apiKeys[0])?.apiKey;
  return cfg.apiKey || undefined;
}

function isLoopbackBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    let host = new URL(baseUrl).hostname.toLowerCase();
    host = host.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host);
  } catch {
    return false;
  }
}

function providerCanRunWithoutSavedKey(cfg: ProviderConfig): boolean {
  return isLoopbackBaseUrl(cfg.baseUrl) && (!cfg.envVars || cfg.envVars.length === 0);
}

function hasUsableSavedProvider(cfg: ProviderConfig): boolean {
  return (
    resolveActiveApiKey(cfg) !== undefined ||
    (Array.isArray(cfg.envVars) &&
      cfg.envVars.some((name) => Boolean(process.env[name]?.trim()))) ||
    providerCanRunWithoutSavedKey(cfg)
  );
}

/**
 * Clear top-level provider/model defaults when provider mutations make them
 * stale. This prevents a removed provider, deleted final key, or edited model
 * allowlist from being accepted on the next boot and crashing provider setup.
 */
export function clearStaleProviderDefaults(
  config: Record<string, unknown>,
  opts?: { preservePrimary?: boolean },
): void {
  const providerId = typeof config['provider'] === 'string' ? config['provider'] : undefined;
  if (!providerId) return;
  const providers = config['providers'] as Record<string, ProviderConfig> | undefined;
  // Setup mode is a placeholder, not a provider: it exists only so a machine
  // with no credential can still open the app. This function runs on every
  // credential write, so reaching it means the user just configured something
  // real — retire the placeholder and let the launch picker offer the real
  // provider next time. The defensive delete covers a hand-edited config that
  // wrote a `providers` entry the code never creates.
  if (isSetupProviderId(providerId)) {
    delete config['provider'];
    delete config['model'];
    if (providers) delete providers[providerId];
    return;
  }
  // An unrelated account write does not own the existing primary selection.
  if (opts?.preservePrimary) return;
  const provider = providers?.[providerId];
  if (!provider || !hasUsableSavedProvider(provider)) {
    delete config['provider'];
    delete config['model'];
    return;
  }
  const modelId = typeof config['model'] === 'string' ? config['model'] : undefined;
  if (
    modelId &&
    Array.isArray(provider.models) &&
    provider.models.length > 0 &&
    !provider.models.includes(modelId)
  ) {
    delete config['model'];
  }
}

export function validateProviderConfigShape(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config must be a JSON object.');
  }
  const providers = (value as Record<string, unknown>)['providers'];
  if (
    providers !== undefined &&
    (!providers || typeof providers !== 'object' || Array.isArray(providers))
  ) {
    throw new Error('config providers must be a JSON object.');
  }
}
