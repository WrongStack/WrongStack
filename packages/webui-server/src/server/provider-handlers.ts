import type { ModelsRegistry, ProviderConfig } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { createCatalogHandlers } from './provider/catalog.js';
import { createCustomModelHandlers } from './provider/custom-models.js';
import { createKeyHandlers, createProviderCrudHandlers } from './provider/keys.js';
import {
  createProviderServiceContext,
  type ProviderOperationsDeps,
  type ProviderPersistence,
} from './provider/mutations.js';
import { createOauthHandlers } from './provider/oauth.js';
import { createProbeHandlers } from './provider/probe.js';
import {
  probeModelDescriptors,
  projectSavedProviders,
  type SavedProviderView,
} from './provider/projection.js';
import { loadSavedProviders, saveProviders } from './provider-config-io.js';
import type { ConnectedClient, WSServerMessage } from './types.js';

/**
 * Per-concern split of the former 827-line provider-handlers.ts (card #6B).
 * This module is the thin composition shell: every handler body moved
 * verbatim into `./provider/*` domain modules; the public surface below is
 * unchanged, so `routes.ts`, the embedded/standalone adapters, the barrel
 * and every test keep importing from here.
 */

export type { ProviderOperationsDeps, ProviderPersistence, SavedProviderView };
export { probeModelDescriptors, projectSavedProviders };

export function createProviderOperations(deps: ProviderOperationsDeps) {
  const ctx = createProviderServiceContext(deps);
  const catalog = createCatalogHandlers(ctx);
  const keys = createKeyHandlers(ctx);
  const crud = createProviderCrudHandlers(ctx);
  const customModels = createCustomModelHandlers(ctx);
  const probe = createProbeHandlers(ctx);
  const oauth = createOauthHandlers(ctx);

  return {
    ...catalog,
    ...keys,
    ...crud,
    ...customModels,
    ...probe,
    ...oauth,
    broadcastSaved: ctx.broadcastSaved,
    loadConfigProviders: ctx.loadConfigProviders,
  };
}

export interface ProviderHandlerDeps {
  /** Path to the active profile config; the only provider mutation target. */
  profileConfigPath: string;
  vault: import('@wrongstack/core/types').SecretVault;
  /** Shared config write lock — serialized via chained promises */
  setConfigWriteLock: (lock: Promise<void>) => void;
  getConfigWriteLock: () => Promise<void>;
  /** Broadcast a message to all connected WebUI clients */
  broadcast: (clients: Map<WebSocket, ConnectedClient>, msg: WSServerMessage) => void;
  /** Connected WebUI clients map */
  clients: Map<WebSocket, ConnectedClient>;
  /** Used by the ChatGPT OAuth flow's tier-2 model lookup (best-effort). */
  modelsRegistry?: ModelsRegistry | undefined;
  hasActiveModel?: (() => boolean) | undefined;
  onProvidersLoaded?:
    | ((providers: Record<string, ProviderConfig>) => void | Promise<void>)
    | undefined;
  applyModelSwitch?: ((providerId: string, modelId: string) => Promise<void>) | undefined;
}

/**
 * Standalone-host adapter. It preserves the existing serialized profile-file
 * persistence while delegating all provider and OAuth behavior to the
 * store-backed canonical operations factory.
 */
export function createProviderHandlers(deps: ProviderHandlerDeps) {
  let configWriteLock = deps.getConfigWriteLock();
  const providerStore: ProviderPersistence = {
    load: () => loadSavedProviders(deps.profileConfigPath, deps.vault),
    save: async (providers) => {
      const next = configWriteLock
        .then(() => saveProviders(deps.profileConfigPath, deps.vault, providers))
        .catch((error) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'webui.provider_save_failed',
              message: toErrorMessage(error),
              timestamp: new Date().toISOString(),
            }),
          );
        });
      configWriteLock = next;
      deps.setConfigWriteLock(next);
      await next;
    },
  };
  return createProviderOperations({
    providerStore,
    broadcast: (message) => deps.broadcast(deps.clients, message),
    modelsRegistry: deps.modelsRegistry,
    log: (message) => console.log(message),
    hasActiveModel: deps.hasActiveModel,
    onProvidersLoaded: deps.onProvidersLoaded,
    applyModelSwitch: deps.applyModelSwitch,
  });
}
