/**
 * Trusted provider presets — vendor-maintained defaults for provider IDs
 * whose product-specific base URL, model allowlist, env vars, and
 * compatibility quirks cannot be derived from the models.dev catalog alone
 * (or would otherwise leak into the user-typed `provider.add` payload).
 *
 * Why a separate module:
 *  - The user-facing setup flow only ships `id`/`family`/`apiKey`; without
 *    a trusted resolver, an OpenAI-compatible provider pointing at
 *    `https://api.kimi.com/coding/v1` would work in the wire but skip the
 *    Kimi-specific reasoning toggle and overwrite the user's explicit base
 *    URL. We persist the canonical product defaults server-side instead.
 *  - Vendor endpoints and model IDs change rarely but matter for
 *    correctness (e.g. the Kimi HighSpeed alias consumes ~3× subscription
 *    quota). Centralising them here keeps the CLI, TUI auth-menu, and
 *    WebUI setup cards aligned.
 *
 * Coverage is intentionally narrow: only providers that need product-aware
 * server-side hydration are listed. Generic OpenAI-compatible gateways
 * (omniroute, LiteLLM, etc.) still rely on user-supplied baseUrl/models.
 */

import type { ProviderConfig } from '@wrongstack/contracts/types';

import { TRUSTED_PROVIDER_PRESETS, type TrustedProviderPreset } from './trusted-preset-table.js';

export type { TrustedProviderPreset } from './trusted-preset-table.js';
export { TRUSTED_PROVIDER_PRESETS } from './trusted-preset-table.js';

const PRESET_IDS = Object.keys(TRUSTED_PROVIDER_PRESETS);

/**
 * Look up a trusted preset by provider id. Returns `undefined` for ids
 * that are not in the trusted table (the generic openai-compatible /
 * anthropic / google path still works for those — see
 * `buildProviderFactoriesFromRegistry`).
 */
export function getTrustedProviderPreset(id: string): TrustedProviderPreset | undefined {
  return TRUSTED_PROVIDER_PRESETS[id];
}

/**
 * List all trusted preset ids. Used by the WebUI `providers.json` and the
 * TUI auth menu to render curated cards in addition to the user-managed
 * providers.
 */
export function listTrustedProviderPresetIds(): string[] {
  return [...PRESET_IDS];
}

/**
 * Build a fresh `ProviderConfig` from a trusted preset, optionally
 * layering an initial API key. The returned object owns its own
 * `customModels`/`models`/`envVars` arrays/maps — callers may mutate
 * freely without affecting the preset table.
 *
 * Notes:
 *  - `type` is set to the preset id so the registry can resolve the
 *    catalog entry by id. When the user picks a custom alias (e.g.
 *    `my-kimi`), callers should set `cfg.type = preset.id` and `cfg.family`
 *    explicitly (or use `buildProviderConfigForAlias`).
 *  - `apiKey` / `apiKeys[]` are not initialised here — callers use the
 *    normal key-write path so the vault encryption flow stays uniform.
 */
export function buildProviderConfigFromPreset(preset: TrustedProviderPreset): ProviderConfig {
  const cfg: ProviderConfig = {
    type: preset.id,
    family: preset.family,
    baseUrl: preset.baseUrl,
    envVars: [...preset.envVars],
    models: [...preset.models],
  };
  if (preset.customModels) {
    cfg.customModels = {};
    for (const [id, def] of Object.entries(preset.customModels)) {
      cfg.customModels[id] = structuredClone(def);
    }
  }
  if (preset.quirks) {
    cfg.quirks = { ...preset.quirks };
  }
  return cfg;
}

/**
 * Repair stale preset metadata on an existing exact-canonical provider.
 * Credentials and user-owned fields are preserved. A provider with a base URL
 * different from the preset is treated as an explicit custom gateway, so its
 * family/models/env vars/quirks are not rewritten. Aliases are also excluded.
 */
export function rehydrateCanonicalProviderConfig(
  providerId: string,
  dest: ProviderConfig,
): boolean {
  const preset = TRUSTED_PROVIDER_PRESETS[providerId];
  if (!preset || providerId !== preset.id) return false;

  const template = buildProviderConfigFromPreset(preset);
  const hasCustomEndpoint = dest.baseUrl !== undefined && dest.baseUrl !== preset.baseUrl;
  const protocolWasStale = dest.type !== preset.id || dest.family !== preset.family;

  dest.type = preset.id;
  if (hasCustomEndpoint) return true;

  dest.family = preset.family;
  if (dest.baseUrl === undefined) dest.baseUrl = template.baseUrl;
  if (!dest.envVars || dest.envVars.length === 0) dest.envVars = template.envVars;

  if (
    protocolWasStale ||
    !dest.models ||
    dest.models.length === 0 ||
    isLegacyZaiDefaultModelList(providerId, dest.models)
  ) {
    const customIds = Object.keys(dest.customModels ?? {});
    const presetModels = template.models ?? [];
    dest.models = [...presetModels, ...customIds.filter((id) => !presetModels.includes(id))];
    if (dest.model !== undefined && !dest.models.includes(dest.model)) {
      dest.model = dest.models[0];
    }
  }

  if (
    template.customModels &&
    (!dest.customModels || Object.keys(dest.customModels).length === 0)
  ) {
    dest.customModels = template.customModels;
  }
  if (template.quirks) {
    dest.quirks = { ...template.quirks, ...(dest.quirks ?? {}) };
  }
  return true;
}

function isLegacyZaiDefaultModelList(providerId: string, models: readonly string[]): boolean {
  if (providerId !== 'zai' && providerId !== 'zai-coding-plan') return false;
  const legacy = new Set(['glm-5.2', 'glm-5-turbo', 'glm-4.7']);
  return models.length === legacy.size && models.every((model) => legacy.has(model));
}

/**
 * Resolve a user-supplied alias against the trusted preset table. Returns
 * the preset when the alias matches a canonical id exactly or when the
 * alias follows the `<id>-<customSuffix>` convention (so a user can save
 * a second Kimi subscription key under `kimi-for-coding-work` without
 * losing the canonical defaults). Returns `undefined` for unknown aliases
 * so the generic registration path can take over.
 */
export function resolvePresetForAlias(alias: string): TrustedProviderPreset | undefined {
  if (TRUSTED_PROVIDER_PRESETS[alias]) return TRUSTED_PROVIDER_PRESETS[alias];
  // Match the longest known prefix so a custom suffix does not steal the
  // canonical preset (e.g. `kimi-for-coding-work` → `kimi-for-coding`).
  let bestMatch: TrustedProviderPreset | undefined;
  for (const preset of Object.values(TRUSTED_PROVIDER_PRESETS)) {
    if (!alias.startsWith(`${preset.id}-`)) continue;
    if (!bestMatch || preset.id.length > bestMatch.id.length) bestMatch = preset;
  }
  return bestMatch;
}

/**
 * True when an id matches a trusted preset exactly. Used by the WebUI
 * setup-card UI to decide whether to send a trusted preset id (and rely
 * on server-side hydration) or a generic id.
 */
export function isTrustedProviderId(id: string): boolean {
  return TRUSTED_PROVIDER_PRESETS[id] !== undefined;
}
