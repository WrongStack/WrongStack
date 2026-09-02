import type { ModelDescriptor } from '../types.js';

/**
 * Provider/model selection helpers for the header switcher.
 *
 * The server speaks three messages that together cover every usable provider:
 * - `provider.catalog` — every catalog provider, flagged `hasApiKey` when a
 *   credential (saved key or env var) is visible server-side.
 * - `providers.saved` — providers with a saved config entry (covers OAuth and
 *   config-only custom providers the catalog may not list).
 * - `provider.models` — the enriched model list for one provider, including
 *   `contextWindow` when known.
 *
 * These functions stay pure so the fetch/warn decisions are unit-testable;
 * `app.tsx` owns the socket sends and state.
 */

export interface CatalogProviderEntry {
  id: string;
  label: string;
  /** True when the server sees a usable credential (saved key or env var). */
  hasApiKey: boolean;
}

/** Parse the `provider.catalog` payload into id/label/hasApiKey entries. */
export function parseCatalogProviders(payload: Record<string, unknown>): CatalogProviderEntry[] {
  const providers = Array.isArray(payload['providers']) ? payload['providers'] : [];
  const entries: CatalogProviderEntry[] = [];
  for (const entry of providers) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (typeof item['id'] !== 'string' || !item['id']) continue;
    entries.push({
      id: item['id'],
      label: typeof item['name'] === 'string' && item['name'] ? item['name'] : item['id'],
      hasApiKey: item['hasApiKey'] === true,
    });
  }
  return entries;
}

/** Parse the `providers.saved` payload into provider ids. */
export function parseSavedProviderIds(payload: Record<string, unknown>): string[] {
  const providers = Array.isArray(payload['providers']) ? payload['providers'] : [];
  const ids: string[] = [];
  for (const entry of providers) {
    if (!entry || typeof entry !== 'object') continue;
    const id = (entry as Record<string, unknown>)['id'];
    if (typeof id === 'string' && id) ids.push(id);
  }
  return ids;
}

/**
 * Decide which providers need a `provider.models` fetch: the live session
 * provider (always selectable, even with creds since removed), every catalog
 * provider with a usable credential, and every saved provider. Ids already in
 * `alreadyRequested` are skipped so catalog + saved overlaps fetch once.
 */
export function providersNeedingModels(input: {
  catalog?: readonly CatalogProviderEntry[] | undefined;
  savedIds?: readonly string[] | undefined;
  currentProvider?: string | undefined;
  alreadyRequested: ReadonlySet<string>;
}): string[] {
  const wanted = new Set<string>();
  if (input.currentProvider) wanted.add(input.currentProvider);
  for (const entry of input.catalog ?? []) {
    if (entry.hasApiKey) wanted.add(entry.id);
  }
  for (const id of input.savedIds ?? []) {
    if (id) wanted.add(id);
  }
  return [...wanted].filter((id) => !input.alreadyRequested.has(id));
}

/** Look up a model's declared context window, undefined when unknown. */
export function findModelContextWindow(
  models: Record<string, ModelDescriptor[]>,
  provider: string,
  modelId: string,
): number | undefined {
  const found = models[provider]?.find((item) => item.id === modelId);
  return found && typeof found.contextWindow === 'number' && found.contextWindow > 0
    ? found.contextWindow
    : undefined;
}

export type ModelSwitchPlan =
  /** Same provider+model as the live session — nothing to do. */
  | { kind: 'noop' }
  /** Switch directly; the new model's context is known-not-smaller or unknown. */
  | { kind: 'switch' }
  /** The new model's context window is smaller — the user must confirm. */
  | {
      kind: 'warn';
      modelName: string;
      currentWindow: number;
      nextWindow: number;
    };

/**
 * Decide what a dropdown selection should do. A warning is only planned when
 * both windows are known and the new one is strictly smaller; unknown windows
 * (custom/probed providers) switch without a warning because no comparison is
 * possible. The current window prefers the catalog descriptor and falls back
 * to the session's effective maxContext.
 */
export function planModelSwitch(input: {
  models: Record<string, ModelDescriptor[]>;
  currentProvider: string;
  currentModel: string;
  /** The live session's effective context window (server compaction denominator). */
  sessionMaxContext?: number | undefined;
  nextProvider: string;
  nextModel: string;
}): ModelSwitchPlan {
  const { models, currentProvider, currentModel, nextProvider, nextModel } = input;
  if (!nextProvider || !nextModel) return { kind: 'noop' };
  if (nextProvider === currentProvider && nextModel === currentModel) return { kind: 'noop' };

  const currentWindow =
    findModelContextWindow(models, currentProvider, currentModel) ??
    (typeof input.sessionMaxContext === 'number' && input.sessionMaxContext > 0
      ? input.sessionMaxContext
      : undefined);
  const nextDescriptor = models[nextProvider]?.find((item) => item.id === nextModel);
  const nextWindow =
    nextDescriptor &&
    typeof nextDescriptor.contextWindow === 'number' &&
    nextDescriptor.contextWindow > 0
      ? nextDescriptor.contextWindow
      : undefined;

  if (currentWindow !== undefined && nextWindow !== undefined && nextWindow < currentWindow) {
    return {
      kind: 'warn',
      modelName: nextDescriptor?.name || nextModel,
      currentWindow,
      nextWindow,
    };
  }
  return { kind: 'switch' };
}
