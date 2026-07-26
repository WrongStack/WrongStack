import type { Config } from '../types/config.js';
import { normalizeModelRef } from '../core/fallback-model.js';

/** Canonicalize a model reference so equivalent spellings dedupe. */
export function normalizeRef(ref: string): string {
  return ref
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s+/g, ' ');
}

/**
 * Validate that a model reference is in the user's favorites list (or that
 * favorites are not enforced). Returns `true` when the ref is valid.
 */
export function isFavoriteRef(ref: string, config: Config): boolean {
  const favorites = config.favoriteModels ?? [];
  if (favorites.length === 0) return true;
  const canonical = normalizeModelRef(ref, config.provider);
  return favorites.some((f) => normalizeModelRef(f, config.provider) === canonical);
}

/** Build a human-friendly error listing provider/model favorites. */
export function notFavoriteError(ref: string, config: Config): string {
  const favorites = config.favoriteModels ?? [];
  return (
    `"${ref}" is not in your favorites list. ` +
    (favorites.length === 0
      ? 'Add some favorites first with favorite_manage({ action: "add", model: "<provider/model>" }).'
      : `Current favorites: ${favorites.join(', ') || '(none)'}. ` +
        'Use favorite_manage to add this model first.')
  );
}

export function modelList(config: Config): string[] {
  return config.favoriteModels ?? [];
}

export function profileList(config: Config): Record<string, string[]> {
  return (config.fallbackProfiles ?? {}) as Record<string, string[]>;
}

export function chainList(config: Config): string[] {
  return config.fallbackModels ?? [];
}
