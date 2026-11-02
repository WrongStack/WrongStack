import type { ProviderConfig } from '@wrongstack/contracts/types';
import type { ProviderModelStatusTracker } from '@wrongstack/coordination';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';

export interface ProviderMutationHandlers {
  handleKeyUpsert: (
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ) => Promise<void>;
  handleKeyDelete: (ws: WebSocket, providerId: string, label: string) => Promise<void>;
  handleKeySetActive: (ws: WebSocket, providerId: string, label: string) => Promise<void>;
  handleProviderAdd: (
    ws: WebSocket,
    payload: {
      id: string;
      type?: string | undefined;
      family: string;
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
      models?: string[] | undefined;
      customModels?: ProviderConfig['customModels'] | undefined;
    },
  ) => Promise<boolean>;
  handleProviderRemove: (ws: WebSocket, providerId: string) => Promise<void>;
  handleProviderClearModels: (ws: WebSocket, providerId: string) => Promise<void>;
  handleCustomModelSet: (
    ws: WebSocket,
    providerId: string,
    modelId: string,
    definition: NonNullable<ProviderConfig['customModels']>[string],
  ) => Promise<void>;
  handleCustomModelRemove: (ws: WebSocket, providerId: string, modelId: string) => Promise<void>;
  handleProviderUndoClear: (
    ws: WebSocket,
    providerId: string,
    previousModels: string[],
  ) => Promise<void>;
  handleProviderUpdate: (
    ws: WebSocket,
    payload: {
      id: string;
      cloud?: ProviderConfig['cloud'] | undefined;
      family?: string | undefined;
      baseUrl?: string | undefined;
      envVars?: string[] | undefined;
      models?: string[] | undefined;
      customModels?: ProviderConfig['customModels'] | undefined;
    },
  ) => Promise<void>;
  handleProviderProbe: (
    ws: WebSocket,
    providerId: string,
    timeoutMs?: number | undefined,
  ) => Promise<void>;
  /** Read MiniMax / Z.AI plan quota from their account endpoints (provider/quota-refresh.ts). */
  handleProviderQuotaRefresh: (ws: WebSocket) => Promise<void>;
  handleProviderModelTestRun: (
    ws: WebSocket,
    input: {
      requestId: string;
      providerId: string;
      modelIds: string[];
      timeoutMs: number;
      maxTokens: number;
    },
  ) => Promise<void>;
  handleProviderModelTestCancel: (requestId: string) => void;
  handleOAuthStart: (
    ws: WebSocket,
    kind: string,
    providerId?: string | undefined,
    attemptId?: string,
  ) => Promise<void>;
  handleOAuthCode: (
    ws: WebSocket,
    kind: string,
    input: string,
    attemptId?: string,
  ) => Promise<void>;
  handleOAuthCancel: (ws: WebSocket, kind: string, attemptId?: string) => void;
  handleOAuthList: (ws: WebSocket) => void;
  resolveOAuthStrategyId: (input: string) => string | undefined;
}

export interface ProviderRouteHandlers {
  listProviders: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listSavedProviders: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listProviderModels: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  searchProviderModels: (ws: WebSocket, query: string, limit?: number | undefined) => Promise<void>;
  switchModel: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  refineModel: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  /** Forward a model.fallback_choice client message to the EventBus. */
  fallbackChoice: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  /** Suggest fallback profiles from the saved providers' catalogs. */
  suggestFallbacks: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  /** Adopt a just-added provider as the live default when no model is active. */
  adoptDefaultProviderIfUnset: (providerId: string) => Promise<void>;
  providerHandlers: ProviderMutationHandlers;
  /** Live provider/model health tracker (the "waiting room"). Undefined when
   * the host is not wired with a tracker (e.g. test harnesses). */
  statusTracker?:
    | Pick<ProviderModelStatusTracker, 'getSnapshot' | 'getStatus' | 'retryNow' | 'clear'>
    | undefined;
  prepareProviderStatus?: (() => Promise<void>) | undefined;
  persistProviderStatusControl?:
    | ((
        providerId: string,
        model: string,
        before: ReturnType<ProviderModelStatusTracker['getStatus']>,
        reason: string,
      ) => Promise<void>)
    | undefined;
  /** Durable block/open audit trail (JSONL) next to the profile config.
   * Undefined when the host did not provide a profile path (test harnesses). */
  providerAuditFile?: string | undefined;
}
