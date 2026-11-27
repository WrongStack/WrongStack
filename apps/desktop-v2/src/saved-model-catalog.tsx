import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { EngineCommand } from './engine-operations';
import { entries } from './engine-values';
import { pickerModel } from './model-picker-details';
import type { SavedModel } from './model-reference-options';
import { useProviderNames } from './provider-names';

/** The saved providers' model catalogs, read once for every model field on a settings page. */
export interface SavedModelCatalog {
  loading: boolean;
  /** Saved provider ids in the engine's order. */
  providers: string[];
  models: SavedModel[];
  /** Display names by provider id, from the provider catalog. */
  names: Record<string, string>;
  /** The engine's message when the saved providers could not be read at all. */
  error: string;
  /** Some provider's models could not be read; the others are still offered. */
  partial: boolean;
}

const empty: SavedModelCatalog = {
  loading: false,
  providers: [],
  models: [],
  names: {},
  error: '',
  partial: false,
};

export function useSavedModelCatalog(command: EngineCommand): SavedModelCatalog {
  const [catalog, setCatalog] = useState<SavedModelCatalog>({ ...empty, loading: true });
  const names = useProviderNames(command);
  useEffect(() => {
    let active = true;
    setCatalog({ ...empty, loading: true });
    void command('providers.saved', {}, ['providers.saved', 'key.operation_result'])
      .then(async (reply) => {
        const providers = entries(reply['providers']).flatMap((row) =>
          typeof row['id'] === 'string' && row['id'] ? [row['id']] : [],
        );
        const results = await Promise.allSettled(
          providers.map(async (providerId) => {
            const result = await command('provider.models', { providerId }, [
              'provider.models',
              'key.operation_result',
            ]);
            return entries(result['models'])
              .filter((row) => typeof row['id'] === 'string')
              .map((row) => ({ provider: providerId, model: pickerModel(row) }));
          }),
        );
        if (!active) return;
        setCatalog({
          ...empty,
          loading: false,
          providers,
          models: results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])),
          partial: results.some((result) => result.status === 'rejected'),
        });
      })
      .catch((error: unknown) => {
        if (active)
          setCatalog({ ...empty, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      active = false;
    };
  }, [command]);
  return useMemo(() => ({ ...catalog, names }), [catalog, names]);
}

const CatalogContext = createContext<SavedModelCatalog>(empty);

/** The page's saved model catalogs; empty until a `ModelCatalogProvider` supplies them. */
export const useModelCatalog = (): SavedModelCatalog => useContext(CatalogContext);

/**
 * Reads the saved catalogs for the model fields inside, once, and says when some of them
 * could not be read. Field values that are not in the catalogs stay editable.
 */
export function ModelCatalogProvider({
  command,
  partialNotice,
  children,
}: {
  command: EngineCommand;
  partialNotice: string;
  children: ReactNode;
}) {
  const catalog = useSavedModelCatalog(command);
  const notice = catalog.error || (catalog.partial ? partialNotice : '');
  return (
    <CatalogContext.Provider value={catalog}>
      {notice && (
        <p className="field-help" role="status">
          {notice}
        </p>
      )}
      {children}
    </CatalogContext.Provider>
  );
}
