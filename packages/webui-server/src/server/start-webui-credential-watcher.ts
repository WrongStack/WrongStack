import { watchProviderConfig } from '@wrongstack/core/storage';
import type { ProviderConfig } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { patchConfig } from './boot.js';
import { projectSavedProviders } from './provider-handlers.js';
import type { WebuiDeps, WebuiMutableState } from './routes.js';
import type { ConnectedClient, WSServerMessage } from './types.js';
import { broadcast } from './ws-utils.js';

export function setupWebuiCredentialWatcher(options: {
  watchConfigPath: string;
  vault: WebuiDeps['vault'];
  logger: WebuiDeps['logger'];
  state: WebuiMutableState;
  deps: WebuiDeps;
  clients: Map<WebSocket, ConnectedClient>;
  updateAutoCompactionMaxContext: (provider: any) => Promise<void>;
}): (() => void) | undefined {
  if (process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] === '1') {
    return undefined;
  }
  const { watchConfigPath, vault, logger, state, deps, clients, updateAutoCompactionMaxContext } =
    options;
  let lastActiveCfg = JSON.stringify(
    state.getConfig().providers?.[deps.context.provider.id] ?? null,
  );
  let lastUiLocale: string | undefined = state.getConfig().uiLocale;
  const credentialWatcher = watchProviderConfig(
    watchConfigPath,
    vault,
    (snapshot) => {
      // Refresh in-memory config + store so panels and the next switch read fresh.
      state.setConfig(
        patchConfig(state.getConfig(), {
          providers: snapshot.providers,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          fallbackBridge: snapshot.fallbackBridge ?? '',
        }),
      );
      deps.configStore.update({
        providers: snapshot.providers,
        ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
        ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
        ...(snapshot.fallbackModels !== undefined
          ? { fallbackModels: snapshot.fallbackModels }
          : {}),
        fallbackBridge: snapshot.fallbackBridge ?? '',
        ...(snapshot.fallbackProfiles !== undefined
          ? { fallbackProfiles: snapshot.fallbackProfiles }
          : {}),
        ...(snapshot.favoriteModels !== undefined
          ? { favoriteModels: snapshot.favoriteModels }
          : {}),
        ...(snapshot.favoriteModelsOnly !== undefined
          ? { favoriteModelsOnly: snapshot.favoriteModelsOnly }
          : {}),
        ...(snapshot.modelMatrix !== undefined ? { modelMatrix: snapshot.modelMatrix } : {}),
        ...(snapshot.fallbackAuto !== undefined ? { fallbackAuto: snapshot.fallbackAuto } : {}),
      } as never);
      broadcast(clients, {
        type: 'providers.saved',
        payload: { providers: projectSavedProviders(snapshot.providers) },
      } as WSServerMessage);

      // Display language live-propagation: when config.uiLocale changes in
      // another process, seed context.meta + broadcast prefs.updated so every
      // connected client re-renders in the new language (handlePrefsUpdated →
      // useLocalPrefs → i18n.changeLanguage).
      const newUi = snapshot.uiLocale;
      if (newUi !== lastUiLocale) {
        lastUiLocale = newUi;
        if (newUi) {
          deps.context.meta['uiLocale'] = newUi;
          broadcast(clients, { type: 'prefs.updated', payload: { uiLocale: newUi } });
        }
      }

      const activeId = deps.context.provider.id;
      const newCfgStr = JSON.stringify(snapshot.providers[activeId] ?? null);
      if (newCfgStr === lastActiveCfg) return; // active provider creds unchanged
      lastActiveCfg = newCfgStr;
      try {
        const providerCfg: ProviderConfig = snapshot.providers[activeId] ?? {
          type: activeId,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
        };
        // WrongProxy / WrongTrace: keep the hot-reloaded provider on the proxy
        // too. A credential/config reload must not silently drop the rewrite
        // and send the live session back to the upstream directly. The live
        // config's top-level baseUrl is the fallback when the saved cfg
        // carries no explicit one (same rule as the other WebUI sites).
        const routedCfg = routeProviderCfgThroughProxy(
          providerCfg,
          state.getConfig().baseUrl,
          activeId,
        );
        const newProv = deps.providerRegistry.has(activeId)
          ? deps.providerRegistry.create({ ...routedCfg, type: activeId } as never)
          : makeProviderFromConfig(activeId, { ...routedCfg, type: activeId });
        deps.context.provider = newProv;
        void updateAutoCompactionMaxContext(newProv).catch(() => undefined);
        console.log(`[WebUI] Provider credentials reloaded from config.json (${activeId})`);
      } catch (err) {
        console.warn(
          `[WebUI] Credential hot-reload failed for ${activeId}: ${toErrorMessage(err)}`,
        );
      }
    },
    { warn: (m) => logger.warn(`Config watcher: ${m}`) },
  );
  return credentialWatcher.close;
}
