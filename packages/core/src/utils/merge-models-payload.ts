import type {
  ModelsDevModel,
  ModelsDevProvider,
  ModelsDevPayload,
} from '../types/models-registry.js';

// Magic keys in the overlay payload that signal deletions rather than additions.
const REMOVE_PROVIDERS_KEY = '_removeProviders';
const REMOVE_MODELS_KEY = '_removeModels';

/**
 * Deep-merge a curated `overlay` payload on top of a `base` payload (both in
 * the models.dev `api.json` shape). The overlay always wins: it can add
 * providers/models the base lacks and override fields the base gets wrong.
 *
 * NEW: The overlay also supports two magic keys for removal:
 *
 *   `_removeProviders` (string[])  — provider ids to DELETE from the result.
 *   `_removeModels` (Record<string, string[]>) — per-provider model ids to
 *     delete from that provider's model list.
 *
 * Removals are applied AFTER the merge pass so the overlay can add and then
 * selectively strip away unwanted entries from the base catalog.
 *
 * Precedence rules:
 *  - Provider present in both → scalar fields (`name`, `npm`, `api`, `env`,
 *    `doc`) come from the overlay when set; `models` maps merge by model id.
 *  - Provider only in the overlay → added wholesale.
 *  - Model present in both → overlay model fields override base model fields
 *    (`{ ...base, ...overlay }`), with the nested `limit` / `cost` /
 *    `modalities` objects merged one level deeper so an overlay can fix just
 *    `limit.context` without restating the rest of the model.
 *  - Model only in the overlay → added.
 *
 * Pure: never mutates its inputs.
 */
export function mergeModelsPayload(
  base: ModelsDevPayload,
  overlay: ModelsDevPayload,
): ModelsDevPayload {
  const safeBase = base && typeof base === 'object' ? base : {};
  const safeOverlay = overlay && typeof overlay === 'object' ? overlay : {};

  // Step 1: extract removal directives before the merge loop
  const removeProviders: string[] = Array.isArray(safeOverlay[REMOVE_PROVIDERS_KEY])
    ? (safeOverlay[REMOVE_PROVIDERS_KEY] as string[])
    : [];
  const removeModels: Record<string, string[]> =
    safeOverlay[REMOVE_MODELS_KEY] && typeof safeOverlay[REMOVE_MODELS_KEY] === 'object'
      ? (safeOverlay[REMOVE_MODELS_KEY] as unknown as Record<string, string[]>)
      : {};

  // Step 2: conventional deep-merge (add/override only)
  const out: ModelsDevPayload = {};
  for (const [id, provider] of Object.entries(safeBase)) {
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    if (provider && typeof provider === 'object') {
      out[id] = cloneProvider(provider);
    }
  }
  for (const [id, ovProvider] of Object.entries(safeOverlay)) {
    // Skip magic keys
    if (id === REMOVE_PROVIDERS_KEY || id === REMOVE_MODELS_KEY) continue;
    if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
    if (!ovProvider || typeof ovProvider !== 'object') continue;
    const existing = out[id];
    out[id] = existing ? mergeProvider(existing, ovProvider) : cloneProvider(ovProvider);
  }

  // Step 3: apply removals
  for (const providerId of removeProviders) {
    if (typeof providerId === 'string') {
      delete out[providerId];
    }
  }
  for (const [providerId, modelIds] of Object.entries(removeModels)) {
    const provider = out[providerId];
    if (!provider?.models || !Array.isArray(modelIds)) continue;
    for (const modelId of modelIds) {
      if (typeof modelId === 'string') {
        delete provider.models[modelId];
      }
    }
  }

  return out;
}

function mergeProvider(base: ModelsDevProvider, overlay: ModelsDevProvider): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {};
  for (const [mid, m] of Object.entries(base.models ?? {})) {
    models[mid] = { ...m };
  }
  for (const [mid, ovModel] of Object.entries(overlay.models ?? {})) {
    const existing = models[mid];
    models[mid] = existing ? mergeModel(existing, ovModel) : { ...ovModel };
  }
  return {
    ...base,
    // Overlay scalar fields win when explicitly provided; otherwise keep base.
    ...stripUndefined({
      id: overlay.id,
      name: overlay.name,
      npm: overlay.npm,
      api: overlay.api,
      env: overlay.env,
      doc: overlay.doc,
    }),
    models,
  };
}

function mergeModel(base: ModelsDevModel, overlay: ModelsDevModel): ModelsDevModel {
  const merged: ModelsDevModel = { ...base, ...overlay };
  // One level deeper for the structured fields so a partial overlay (e.g. only
  // `limit.context`) doesn't blow away the base's other sub-fields.
  if (base.limit || overlay.limit) {
    merged.limit = { ...base.limit, ...overlay.limit };
  }
  if (base.cost || overlay.cost) {
    merged.cost = { ...base.cost, ...overlay.cost };
  }
  if (base.modalities || overlay.modalities) {
    merged.modalities = { ...base.modalities, ...overlay.modalities };
  }
  return merged;
}

function cloneProvider(p: ModelsDevProvider): ModelsDevProvider {
  const models: Record<string, ModelsDevModel> = {};
  for (const [mid, m] of Object.entries(p.models ?? {})) {
    models[mid] = { ...m };
  }
  return { ...p, models };
}

/** Drop keys whose value is `undefined` so they don't clobber base fields. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}
