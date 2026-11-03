import type { ProviderClient } from '@wrongstack/project-surfaces/providers/provider-host';
import type { SetupHost } from '@wrongstack/project-surfaces/setup/setup-host';
import { toast } from '@/components/Toaster';
import { useWebSocket } from '@/hooks/useWebSocket';
import { showPanel } from '@/lib/view-navigation';
import { getWSClient } from '@/lib/ws-client';
import { useConfigStore } from '@/stores';
import { useSystemPromptStore } from '@/stores/system-prompt-store';

/** The popular-provider list published with the repository, read when the server has none. */
const PUBLISHED_POPULAR_PROVIDERS =
  'https://raw.githubusercontent.com/WrongStack/WrongStack/main/packages/webui/public/providers.json';

/** The first-run setup on the WebUI's socket and config store. */
export const webuiSetupHost: SetupHost = {
  useClient: () => useWebSocket().client as unknown as ProviderClient | null,
  useConnected: () => useConfigStore((state) => state.wsConnected),
  useCurrentModel: () => useConfigStore((state) => state.model),
  notify: {
    success: (message) => toast.success(message),
    error: (message) => toast.error(message),
  },
  // The served copy first (dev / self-hosted), then the published one.
  popularSources: () => [`${window.location.origin}/providers.json`, PUBLISHED_POPULAR_PROVIDERS],
  chooseModel: async (provider, model, start) => {
    const config = useConfigStore.getState();
    config.setProvider(provider);
    config.setModel(model);
    // `model.switch` persists the choice on the server and broadcasts a session.start.
    const result = await getWSClient(config.wsUrl).switchModel(provider, model, 5_000);
    if (!result.success) return result;
    // First run in the truest sense: provider and model are settled, so the last thing left
    // to size is the system prompt. The picker starts the session on confirm, and marks the
    // question asked so App's first-run effect does not raise it a second time.
    if (start) useSystemPromptStore.getState().openPicker({ startsSession: true });
    showPanel('chat');
    return result;
  },
};
