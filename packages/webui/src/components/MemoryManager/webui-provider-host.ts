import type {
  ProviderClient,
  ProviderHost,
} from '@wrongstack/project-surfaces/providers/provider-host';
import { useMemo } from 'react';
import { useModelsInUse } from '@/components/Quota/use-models-in-use';
import { useWebSocket } from '@/hooks/useWebSocket';
import { openMainView, showPanel } from '@/lib/view-navigation';
import { useConfigStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';

/** The provider test and plan-quota pages on the WebUI's socket, config and local prefs. */
export const webuiProviderHost: ProviderHost = {
  useClient: () => useWebSocket().client as unknown as ProviderClient | null,
  useConnected: () => useConfigStore((state) => state.wsConnected),
  useActiveModel: () => {
    const provider = useConfigStore((state) => state.provider);
    const model = useConfigStore((state) => state.model);
    return useMemo(() => ({ provider, model }), [provider, model]);
  },
  useModelPrefs: () => {
    const prefs = useLocalPrefs();
    const ws = useWebSocket();
    return {
      favoriteModels: prefs.favoriteModels,
      disabledModels: prefs.disabledModels,
      disabledProviders: prefs.disabledProviders,
      fallbackModels: prefs.fallbackModels,
      fallbackProfiles: prefs.fallbackProfiles,
      // Local prefs keep the WebUI's own copy; the engine keeps the shared one.
      update: (patch) => {
        prefs.set(patch);
        ws.updatePrefs({ ...patch });
      },
    };
  },
  useModelsInUse: () => useModelsInUse(),
  back: () => showPanel('chat'),
  openSettings: () => openMainView('settings'),
};
