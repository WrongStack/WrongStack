import type { Config, ProviderConfig } from '@wrongstack/contracts/types/config';
import { parseModelRef } from './model-ref.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Normalize a "list of model refs" config field to `readonly string[] | undefined`.
 *
 * The credential/routing hot-reload watcher clears absent fields by writing
 * `null` (`provider-runtime-setup.ts`: `mergedPatch[key] = merged[key] ?? null`),
 * and `patchConfig` is a plain spread — so `config.fallbackModels` can be `null`
 * at runtime even though the declared type is `string[] | undefined`. A bare
 * `!== undefined` check then walks straight into `null.length`, which threw
 * INSIDE the fallback chain resolver: the TypeError replaced the 429 that
 * triggered the hop and no fallback was ever attempted.
 *
 * Every entry point that reads such a field goes through here, so a null (or
 * any non-array) simply means "not configured".
 */
export function asRefList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) ? (value as readonly string[]) : undefined;
}

/** Same normalization for the single-profile-name fields. */
export function asProfileName(value: unknown): string | undefined {
  return hasText(value) ? value : undefined;
}

export function providerHasKey(entry: ProviderConfig | undefined): boolean {
  if (!entry) return false;
  if (hasText(entry.apiKey)) return true;
  if (Array.isArray(entry.apiKeys) && entry.apiKeys.some((k) => hasText(k?.apiKey))) return true;
  if (Array.isArray(entry.envVars) && entry.envVars.some((v) => hasText(process.env[v])))
    return true;
  return false;
}

export function visibleProviderModels(
  config: Config,
  providerId: string,
  providerModels: string[],
): string[] {
  const entry = config.providers?.[providerId];
  return Array.isArray(entry?.models) ? [...entry.models] : providerModels;
}

export function disabledModelKeys(config: Config): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const ref of asRefList(config.disabledModels) ?? []) {
    const parsed = parseModelRef(ref);
    if (!parsed.model) continue;
    keys.add(`${parsed.provider ?? config.provider}/${parsed.model}`.toLowerCase());
  }
  return keys;
}

export function isDisabledModel(
  disabled: ReadonlySet<string>,
  providerId: string,
  model: string,
): boolean {
  return disabled.has(`${providerId}/${model}`.toLowerCase());
}

/**
 * Provider ids the user switched off entirely (`config.disabledProviders`).
 *
 * Bare ids matched case-insensitively — the provider-level analogue of
 * {@link disabledModelKeys}. A set (not the raw array) so the three resolution
 * loops pay one lookup per candidate instead of a linear scan.
 */
export function disabledProviderKeys(config: Config): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const id of asRefList(config.disabledProviders) ?? []) {
    if (typeof id !== 'string') continue;
    const normalized = id.trim().toLowerCase();
    if (normalized) keys.add(normalized);
  }
  return keys;
}

export function isDisabledProvider(disabled: ReadonlySet<string>, providerId: string): boolean {
  return disabled.has(providerId.trim().toLowerCase());
}

export function buildProfiles(config: Config): ReadonlyMap<string, readonly string[]> {
  const entries = new Map<string, readonly string[]>();
  for (const [name, chain] of Object.entries(config.fallbackProfiles ?? {})) {
    if (Array.isArray(chain) && chain.length > 0) {
      entries.set(name, Object.freeze([...chain]));
    }
  }
  return entries;
}
