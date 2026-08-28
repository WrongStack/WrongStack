import type { ModelsRegistry, ProviderConfig } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from '../types.js';
import { send as sendToSocket } from '../ws-utils.js';
import { projectSavedProviders } from './projection.js';

export interface ProviderPersistence {
  load(): Promise<Record<string, ProviderConfig>>;
  save(providers: Record<string, ProviderConfig>): Promise<void>;
}

export interface ProviderOperationsDeps {
  providerStore: ProviderPersistence;
  broadcast: (message: WSServerMessage) => void;
  send?: ((ws: WebSocket, message: WSServerMessage) => void) | undefined;
  modelsRegistry?: ModelsRegistry | undefined;
  log?: ((message: string) => void) | undefined;
  hasActiveModel?: (() => boolean) | undefined;
  onProvidersLoaded?:
    | ((providers: Record<string, ProviderConfig>) => void | Promise<void>)
    | undefined;
  applyModelSwitch?: ((providerId: string, modelId: string) => Promise<void>) | undefined;
}

/**
 * Shared service context for every provider/ domain module (6B-1).
 * Owns the load → mutate → save → broadcast plumbing each handler repeated,
 * so domain modules stay verbatim handlers with no boilerplate of their own.
 */
export interface ProviderServiceContext {
  readonly deps: ProviderOperationsDeps;
  sendMessage(ws: WebSocket, message: WSServerMessage): void;
  sendOperationResult(ws: WebSocket, success: boolean, message: string): void;
  loadConfigProviders(): Promise<Record<string, ProviderConfig>>;
  saveConfigProviders(providers: Record<string, ProviderConfig>): Promise<void>;
  /** Broadcast the current saved-provider list to every connected client. */
  broadcastSaved(providers: Record<string, ProviderConfig>): void;
}

export function createProviderServiceContext(deps: ProviderOperationsDeps): ProviderServiceContext {
  const sendMessage = deps.send ?? sendToSocket;
  return {
    deps,
    sendMessage,
    sendOperationResult: (ws, success, message) =>
      sendMessage(ws, { type: 'key.operation_result', payload: { success, message } }),
    loadConfigProviders: () => deps.providerStore.load(),
    saveConfigProviders: (providers) => deps.providerStore.save(providers),
    broadcastSaved: (providers) => {
      deps.broadcast({
        type: 'providers.saved',
        payload: { providers: projectSavedProviders(providers) },
      });
    },
  };
}

;
