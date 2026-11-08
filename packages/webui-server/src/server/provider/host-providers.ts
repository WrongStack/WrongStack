/**
 * Providers the host serves itself, beside the saved and catalog ones: the
 * CLI's ACP leader (`acp`, one "model" per installed agent such as
 * `claude-code`). They have no saved record and no models.dev entry, so the
 * pickers only offer them when the host lists them here.
 */
import type { SavedProviderView } from './projection.js';

export interface HostProviderModel {
  id: string;
  name?: string | undefined;
  description?: string | undefined;
  contextWindow?: number | undefined;
  reasoningEffortLevels?: string[] | undefined;
  effortSupported?: boolean | undefined;
}

export interface HostProvider {
  id: string;
  type: string;
  /** Account read supplied by the host, for providers without saved credentials. */
  refreshQuota?: (() => Promise<boolean>) | undefined;
  models: readonly HostProviderModel[];
}

/** Saved providers plus the host's own, which never shadow a saved record of the same id. */
export function withHostProviders(
  saved: SavedProviderView[],
  host: readonly HostProvider[] | undefined,
): SavedProviderView[] {
  if (!host?.length) return saved;
  const ids = new Set(saved.map((view) => view.id));
  const extra = host
    .filter((provider) => provider.models.length > 0 && !ids.has(provider.id))
    .map(
      (provider): SavedProviderView => ({
        id: provider.id,
        type: provider.type,
        family: provider.type,
        models: provider.models.map((model) => model.id),
        pickedModelId: provider.models[0]?.id,
        hostServed: true,
        apiKeys: [],
      }),
    );
  return [...saved, ...extra];
}

/** The `provider.models` rows of a host provider, or undefined when the host does not serve it. */
export function hostProviderModels(
  host: readonly HostProvider[] | undefined,
  providerId: string,
): Array<HostProviderModel & { outputModalities: string[] }> | undefined {
  const provider = host?.find((candidate) => candidate.id === providerId);
  return provider?.models.map((model) => ({ ...model, outputModalities: ['text'] }));
}
