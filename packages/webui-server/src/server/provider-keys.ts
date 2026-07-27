import { expectDefined } from '@wrongstack/core/utils';
import {
  buildProviderConfigFromPreset,
  rehydrateCanonicalProviderConfig,
  resolvePresetForAlias,
} from '@wrongstack/providers';
/**
 * Pure provider/API-key record transforms for the WebUI server's `key.*` and
 * `provider.*` WebSocket handlers.
 *
 * These operate on an in-memory `providers` record (the decrypted
 * `config.providers` map) and return a `{ ok, message }` result mirroring the
 * status string the handler sends back to the client. All persistence
 * (load/decrypt, encrypt/atomic-write) and WS messaging stays in `index.ts` —
 * keeping this layer pure means the security-sensitive key bookkeeping (which
 * key is active, when a provider is dropped, how legacy single-key configs are
 * normalized) is unit-testable without a vault or a socket.
 *
 * Extracted from `index.ts`; transforms mutate the passed record in place, the
 * same way the original handlers did before calling `saveProviders`.
 */
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/core/types';
export type ProvidersRecord = Record<string, ProviderConfig>;

export interface KeyOpResult {
  ok: boolean;
  message: string;
}

/**
 * Normalize a provider's keys to the array form, upgrading a legacy single
 * `apiKey` string to a one-element `[{ label: 'default', ... }]` list. Returns
 * fresh copies so callers can mutate without aliasing the stored config.
 */
export function normalizeKeys(cfg: ProviderConfig): ProviderApiKey[] {
  if (Array.isArray(cfg.apiKeys) && cfg.apiKeys.length > 0) {
    return cfg.apiKeys.map((k) => ({ ...k }));
  }
  if (typeof cfg.apiKey === 'string' && cfg.apiKey.length > 0) {
    return [{ label: 'default', apiKey: cfg.apiKey, createdAt: '' }];
  }
  return [];
}

/**
 * Write a normalized key list back onto a provider config: drop all key fields
 * when empty, otherwise sync `apiKeys` and re-point `activeKey` if it no longer
 * names a present key. Does NOT mirror the plaintext key to the legacy `apiKey`
 * field — that would leak the secret on accidental serialization. Consumers
 * that need the real key should read from `apiKeys[]` directly.
 */
export function writeKeysBack(cfg: ProviderConfig, keys: ProviderApiKey[]): void {
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

/** Mask a secret for display: `••••` for short keys, `abcd…wxyz` otherwise. */
export function maskedKey(key: string | undefined): string {
  if (!key) return '—';
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/**
 * Hydrate a not-yet-saved provider config from a trusted preset when the
 * supplied id (or its `<id>-suffix` alias) maps to a canonical preset.
 * Mutates `dest` in place and returns the canonical preset id (which the
 * caller should use as `cfg.type` so the registry lookup still resolves).
 *
 * Returns `undefined` for unknown ids so the generic registration path
 * can take over (preserving the prior behaviour for user-typed custom
 * gateways and any third-party provider).
 */
function hydratePresetConfig(providerId: string, dest: ProviderConfig): string | undefined {
  const preset = resolvePresetForAlias(providerId);
  if (!preset) return undefined;
  const template = buildProviderConfigFromPreset(preset);
  // Apply preset defaults without overwriting any field the caller may
  // already have set (e.g. `family` on a config-only custom alias). The
  // preset always wins for the four product-locked fields: `baseUrl`,
  // `envVars`, `models`, `customModels`, `quirks`.
  if (!dest.type) dest.type = preset.id;
  if (!dest.family) dest.family = preset.family;
  if (dest.baseUrl === undefined) dest.baseUrl = template.baseUrl;
  if (!dest.envVars || dest.envVars.length === 0) dest.envVars = template.envVars;
  // Model availability/capability facts are product-locked for trusted
  // presets. A generic provider.add client must not replace them with metadata
  // selected for an unrelated custom endpoint.
  dest.models = template.models;
  if (template.customModels) dest.customModels = template.customModels;
  else delete dest.customModels;
  if (template.quirks && dest.quirks === undefined) dest.quirks = template.quirks;
  return preset.id;
}

/** Add or replace a labeled key for a provider, creating the provider if new. */
export function upsertKey(
  providers: ProvidersRecord,
  providerId: string,
  label: string,
  apiKey: string,
  nowIso: string,
): KeyOpResult {
  let existing: ProviderConfig | undefined = providers[providerId];
  if (!existing) {
    // New entry: hydrate from a trusted preset when the id (or its
    // <id>-suffix alias) maps to a canonical vendor entry — this is how
    // the WebUI setup card for Kimi Code / Moonshot Platform / Z.AI ends
    // up with the right baseUrl, model allowlist, and compatibility
    // quirks without the user having to type them.
    existing = { type: providerId };
    const presetId = hydratePresetConfig(providerId, existing);
    if (presetId) existing.type = presetId;
  } else {
    // Setup cards use key.upsert for already-saved providers. Repair stale
    // canonical preset metadata here without touching credentials or a
    // user-owned custom endpoint.
    rehydrateCanonicalProviderConfig(providerId, existing);
  }
  const keys = normalizeKeys(existing);
  const idx = keys.findIndex((k) => k.label === label);
  if (idx >= 0) {
    keys[idx] = { ...expectDefined(keys[idx]), apiKey, createdAt: nowIso };
  } else {
    keys.push({ label, apiKey, createdAt: nowIso });
  }
  writeKeysBack(existing, keys);
  if (!existing.activeKey) existing.activeKey = label;
  providers[providerId] = existing;
  return { ok: true, message: `Key "${label}" saved for ${providerId}` };
}

/** Remove a labeled key; drops the provider entirely when its last key goes. */
export function deleteKey(
  providers: ProvidersRecord,
  providerId: string,
  label: string,
): KeyOpResult {
  const existing = providers[providerId];
  if (!existing) {
    return { ok: false, message: `Provider "${providerId}" not found` };
  }
  const keys = normalizeKeys(existing).filter((k) => k.label !== label);
  if (keys.length === 0) {
    delete providers[providerId];
  } else {
    writeKeysBack(existing, keys);
    if (existing.activeKey === label) existing.activeKey = keys[0]?.label;
    providers[providerId] = existing;
  }
  return { ok: true, message: `Key "${label}" deleted from ${providerId}` };
}

/** Point a provider's active key at the given label. */
export function setActiveKey(
  providers: ProvidersRecord,
  providerId: string,
  label: string,
): KeyOpResult {
  const existing = providers[providerId];
  if (!existing) {
    return { ok: false, message: `Provider "${providerId}" not found` };
  }
  existing.activeKey = label;
  writeKeysBack(existing, normalizeKeys(existing));
  providers[providerId] = existing;
  return { ok: true, message: `Active key for ${providerId} set to "${label}"` };
}

/** Register a brand-new provider (optionally with an initial `default` key). */
export function addProvider(
  providers: ProvidersRecord,
  payload: {
    id: string;
    family: string;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    models?: string[] | undefined;
    customModels?: ProviderConfig['customModels'] | undefined;
  },
  nowIso: string,
): KeyOpResult {
  if (providers[payload.id]) {
    return {
      ok: false,
      message: `Provider "${payload.id}" already exists. Use key.add to add a key.`,
    };
  }
  // Trust the trusted-preset table for product-locked fields. If the id
  // is a known preset (canonical or `<id>-suffix`), `hydratePresetConfig`
  // populates `baseUrl`, `models`, `customModels`, and `quirks` from the
  // preset. `family` still falls back to the wire value supplied by the
  // setup flow (the WebSocket payload) — preset only fills it in when
  // absent — so a user-supplied override survives.
  const newProv: ProviderConfig = {
    type: payload.id,
    family: payload.family as ProviderConfig['family'],
    baseUrl: payload.baseUrl,
    ...(payload.models !== undefined ? { models: [...payload.models] } : {}),
    ...(payload.customModels !== undefined
      ? { customModels: structuredClone(payload.customModels) }
      : {}),
  };
  const presetId = hydratePresetConfig(payload.id, newProv);
  if (presetId) newProv.type = presetId;
  if (payload.apiKey) {
    newProv.apiKeys = [{ label: 'default', apiKey: payload.apiKey, createdAt: nowIso }];
    newProv.activeKey = 'default';
  }
  providers[payload.id] = newProv;
  return { ok: true, message: `Provider "${payload.id}" added` };
}

/** Remove an entire provider and all its keys. */
export function removeProvider(providers: ProvidersRecord, providerId: string): KeyOpResult {
  if (!providers[providerId]) {
    return { ok: false, message: `Provider "${providerId}" not found` };
  }
  delete providers[providerId];
  return { ok: true, message: `Provider "${providerId}" removed` };
}
