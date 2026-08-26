import { useEffect, useMemo, useState } from 'react';
import { isModelInFavorites } from '@/components/QuickModelSwitcher.filter';
import { useWebSocket } from '@/hooks/useWebSocket';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import type { WSServerMessage } from '@/types';

export interface ModelCandidate {
  provider: string;
  model: string;
  label: string;
  description?: string | undefined;
  contextWindow?: number | undefined;
  outputModalities?: string[] | undefined;
  isFavorite?: boolean | undefined;
}

/**
 * Load the flat list of {provider, model} the user can assign to an SDD worker.
 * Reuses the same WS round-trip the QuickModelSwitcher uses: ask for the saved
 * providers (the keyed ones), then lazy-load each provider's model catalogue.
 * `active` gates the fetch so the request only fires while a picker is open.
 */
export function useProviderModels(active: boolean): ModelCandidate[] {
  const wsUrl = useConfigStore((s) => s.wsUrl);
  const favoriteModels = useLocalPrefs((s) => s.favoriteModels);
  const { listSavedProviders, listProviderModels } = useWebSocket();
  const [saved, setSaved] = useState<string[]>([]);
  const [byProvider, setByProvider] = useState<
    Record<
      string,
      Array<{
        id: string;
        name?: string;
        description?: string;
        contextWindow?: number;
        outputModalities?: string[];
      }>
    >
  >({});

  useEffect(() => {
    const client = getWSClient(wsUrl);
    const offSaved = client.on('providers.saved', (msg: WSServerMessage) => {
      const p = msg.payload as { providers?: Array<{ id: string }> };
      setSaved((p.providers ?? []).map((x) => x.id));
    });
    const offModels = client.on('provider.models', (msg: WSServerMessage) => {
      const p = msg.payload as {
        provider: string;
        models?: Array<{
          id: string;
          name?: string;
          description?: string;
          contextWindow?: number;
          outputModalities?: string[];
        }>;
      };
      setByProvider((prev) => ({ ...prev, [p.provider]: p.models ?? [] }));
    });
    return () => {
      offSaved();
      offModels();
    };
  }, [wsUrl]);

  useEffect(() => {
    if (active) listSavedProviders();
  }, [active, listSavedProviders]);

  useEffect(() => {
    if (!active) return;
    for (const id of saved) if (!byProvider[id]) listProviderModels(id);
  }, [active, saved, byProvider, listProviderModels]);

  return useMemo(() => {
    const out: ModelCandidate[] = [];
    for (const provider of saved) {
      for (const m of byProvider[provider] ?? []) {
        // Unknown modalities remain eligible for custom/local providers. A
        // catalog model that explicitly cannot emit text cannot drive an
        // agent or prompt-refiner completion.
        if (m.outputModalities?.length && !m.outputModalities.includes('text')) continue;
        out.push({
          provider,
          model: m.id,
          label: m.name ?? m.id,
          description: m.description,
          contextWindow: m.contextWindow,
          outputModalities: m.outputModalities,
          isFavorite: isModelInFavorites(provider, m.id, favoriteModels),
        });
      }
    }
    return out;
  }, [saved, byProvider, favoriteModels]);
}
