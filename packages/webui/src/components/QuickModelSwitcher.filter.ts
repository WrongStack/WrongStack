/**
 * Pure filtering / ranking helpers for the Cmd+M QuickModelSwitcher.
 * Kept separate from the React component so the logic can be unit-tested
 * without a renderer, and so the useMemo in the component is a thin
 * wrapper that calls into here.
 */

export interface SavedProviderLite {
  id: string;
}

export interface CatalogModelLite {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  contextWindow?: number | undefined;
}

export interface ModelCandidate {
  provider: string;
  model: string;
  modelName: string;
  description?: string | undefined;
  contextWindow?: number | undefined;
  isCurrent: boolean;
  isFavorite: boolean;
}

/**
 * Check whether a (provider, model) pair is contained in the user's
 * favoriteModels list (from config / fallback favorites).
 * Supports both qualified "provider/model" and bare "model" forms,
 * with case-insensitive matching and whitespace tolerance.
 */
export function isModelInFavorites(
  provider: string,
  model: string,
  favoriteModels?: readonly string[] | null,
): boolean {
  if (!favoriteModels || favoriteModels.length === 0) return false;
  const pLower = provider.toLowerCase().trim();
  const mLower = model.toLowerCase().trim();
  const full = `${pLower}/${mLower}`;

  return favoriteModels.some((raw) => {
    if (!raw) return false;
    const clean = raw.trim().toLowerCase();
    if (clean === full || clean === mLower) return true;
    const slashIdx = clean.indexOf('/');
    if (slashIdx !== -1) {
      const favProv = clean.slice(0, slashIdx).trim();
      const favModel = clean.slice(slashIdx + 1).trim();
      return favProv === pLower && favModel === mLower;
    }
    const parts = clean.split(/\s+/);
    if (parts.length >= 2) {
      return parts[0] === pLower && parts.slice(1).join(' ') === mLower;
    }
    return clean === mLower;
  });
}

/**
 * Build the full list of (provider, model) candidates from saved
 * providers and the cached model catalog, apply the search filter
 * (case-insensitive substring on provider / model id / model name),
 * optional provider filter, and optional favorites-only filter,
 * and sort so the currently-active model floats to the top.
 *
 * Filters combine with AND semantics: when multiple are active,
 * candidates must match all criteria.
 *
 * An empty / whitespace-only `query` returns the unfiltered list
 * (unless other filters are set).
 */
export function buildModelCandidates(
  saved: SavedProviderLite[],
  modelsByProvider: Record<string, CatalogModelLite[]>,
  query: string,
  currentProvider: string | undefined,
  currentModel: string | undefined,
  providerFilter?: string | null,
  favoritesOnly?: boolean,
  favoriteModels?: readonly string[],
): ModelCandidate[] {
  const list: ModelCandidate[] = [];
  for (const sp of saved) {
    if (providerFilter && sp.id !== providerFilter) continue;
    const models = modelsByProvider[sp.id] ?? [];
    for (const m of models) {
      const isFav = isModelInFavorites(sp.id, m.id, favoriteModels);
      if (favoritesOnly && !isFav) continue;
      list.push({
        provider: sp.id,
        model: m.id,
        modelName: m.name || m.id,
        description: m.description,
        contextWindow: m.contextWindow,
        isCurrent: sp.id === currentProvider && m.id === currentModel,
        isFavorite: isFav,
      });
    }
  }

  const q = query.toLowerCase().trim();
  const filtered = q
    ? list.filter(
        (c) =>
          c.provider.toLowerCase().includes(q) ||
          c.model.toLowerCase().includes(q) ||
          c.modelName.toLowerCase().includes(q) ||
          c.description?.toLowerCase().includes(q),
      )
    : list;

  return filtered.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    return a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model);
  });
}
