import type { CustomModelDefinition } from '../types/config.js';

/**
 * Merge per-provider `customModels` into top-level `configModels`.
 *
 * Keys present in `configModels` always win over `providerCustomModels`
 * when the same model id appears in both places. This lets the user
 * override provider-attached definitions from the top-level config.
 *
 * Pure: never mutates its inputs.
 */
export function mergeCustomModelDefs(
  providerCustomModels: Record<string, CustomModelDefinition> | undefined,
  configModels: Record<string, CustomModelDefinition> | undefined,
): Record<string, CustomModelDefinition> | undefined {
  const out: Record<string, CustomModelDefinition> = {};

  // Layer 1: provider-level definitions (weaker).
  if (
    providerCustomModels &&
    typeof providerCustomModels === 'object' &&
    !Array.isArray(providerCustomModels)
  ) {
    for (const [id, def] of Object.entries(providerCustomModels)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      if (def && typeof def === 'object') {
        out[id] = { ...def };
      }
    }
  }

  // Layer 2: top-level definitions (stronger).
  if (configModels && typeof configModels === 'object' && !Array.isArray(configModels)) {
    for (const [id, def] of Object.entries(configModels)) {
      if (id === '__proto__' || id === 'constructor' || id === 'prototype') continue;
      if (def && typeof def === 'object') {
        out[id] = { ...def }; // top-level overwrites provider-level
      }
    }
  }

  if (Object.keys(out).length === 0) return undefined;
  return out;
}
