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
}

/**
 * Build the full list of (provider, model) candidates from saved
 * providers and the cached model catalog, apply the search filter
 * (case-insensitive substring on provider / model id / model name)
 * and optional provider filter, and sort so the currently-active model
 * floats to the top.
 *
 * The two filters combine with AND semantics: when both are active,
 * candidates must match the query AND belong to the selected provider.
 *
 * An empty / whitespace-only `query` returns the unfiltered list
 * (unless `providerFilter` is set).
 */
export function buildModelCandidates(
  saved: SavedProviderLite[],
  modelsByProvider: Record<string, CatalogModelLite[]>,
  query: string,
  currentProvider: string | undefined,
  currentModel: string | undefined,
  providerFilter?: string | null,
): ModelCandidate[] {
  const list: ModelCandidate[] = [];
  for (const sp of saved) {
    if (providerFilter && sp.id !== providerFilter) continue;
    const models = modelsByProvider[sp.id] ?? [];
    for (const m of models) {
      list.push({
        provider: sp.id,
        model: m.id,
        modelName: m.name || m.id,
        description: m.description,
        contextWindow: m.contextWindow,
        isCurrent: sp.id === currentProvider && m.id === currentModel,
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
