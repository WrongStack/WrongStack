/** A model chosen through a picker on this desktop, for one-click switching back to it. */
export interface RecentModel {
  provider: string;
  model: string;
}

export const RECENT_MODELS_KEY = 'wrongstack.desktop.recentModels';
export const MAX_RECENT_MODELS = 5;

/** Saved recents, ignoring anything malformed; storage failures read as no recents. */
export function readRecentModels(read: () => string | null): RecentModel[] {
  try {
    const value: unknown = JSON.parse(read() ?? '[]');
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is RecentModel =>
          !!item &&
          typeof item.provider === 'string' &&
          !!item.provider &&
          typeof item.model === 'string' &&
          !!item.model,
      )
      .map(({ provider, model }) => ({ provider, model }))
      .slice(0, MAX_RECENT_MODELS);
  } catch {
    return [];
  }
}

/** The chosen model first, without duplicates, bounded. */
export function withRecentModel(list: readonly RecentModel[], entry: RecentModel): RecentModel[] {
  return [
    entry,
    ...list.filter((item) => item.provider !== entry.provider || item.model !== entry.model),
  ].slice(0, MAX_RECENT_MODELS);
}
