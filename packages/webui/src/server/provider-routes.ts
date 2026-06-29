import type { WebSocket } from 'ws';
import type { createProviderHandlers } from './provider-handlers.js';
import type { WSClientMessage } from './types.js';
import { sendResult } from './ws-utils.js';

export interface ProviderRouteHandlers {
  listProviders: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listSavedProviders: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  listProviderModels: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  switchModel: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  refineModel: (ws: WebSocket, msg: WSClientMessage) => Promise<void>;
  providerHandlers: ReturnType<typeof createProviderHandlers>;
}

function asPayloadRecord(msg: WSClientMessage): Record<string, unknown> | null {
  const payload = msg.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function requiredString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined | null {
  const value = payload[key];
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function optionalStringArray(payload: Record<string, unknown>, key: string): string[] | undefined | null {
  const value = payload[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

function invalidPayload(ws: WebSocket, type: string): true {
  sendResult(ws, false, `${type} payload is invalid`);
  return true;
}

const OAUTH_KINDS = new Set(['chatgpt', 'claude', 'copilot']);
function oauthKind(payload: Record<string, unknown> | null): 'chatgpt' | 'claude' | 'copilot' | null {
  const kind = payload?.['kind'];
  return typeof kind === 'string' && OAUTH_KINDS.has(kind)
    ? (kind as 'chatgpt' | 'claude' | 'copilot')
    : null;
}

export async function handleProviderRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  routes: ProviderRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'providers.list':
      await routes.listProviders(ws, msg);
      return true;
    case 'providers.saved':
      await routes.listSavedProviders(ws, msg);
      return true;
    case 'provider.models':
      await routes.listProviderModels(ws, msg);
      return true;
    case 'model.switch':
      await routes.switchModel(ws, msg);
      return true;
    case 'model.refine':
      await routes.refineModel(ws, msg);
      return true;

    case 'key.add':
    case 'key.update': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const label = payload ? requiredString(payload, 'label') : null;
      const apiKey = payload ? requiredString(payload, 'apiKey') : null;
      if (!providerId || !label || !apiKey) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleKeyUpsert(ws, providerId, label, apiKey);
      return true;
    }

    case 'key.delete': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const label = payload ? requiredString(payload, 'label') : null;
      if (!providerId || !label) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleKeyDelete(ws, providerId, label);
      return true;
    }

    case 'key.set_active': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const label = payload ? requiredString(payload, 'label') : null;
      if (!providerId || !label) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleKeySetActive(ws, providerId, label);
      return true;
    }

    case 'provider.add': {
      const payload = asPayloadRecord(msg);
      const id = payload ? requiredString(payload, 'id') : null;
      const family = payload ? requiredString(payload, 'family') : null;
      const baseUrl = payload?.['baseUrl'];
      const apiKey = payload?.['apiKey'];
      if (!id || !family) return invalidPayload(ws, msg.type);
      if (baseUrl !== undefined && typeof baseUrl !== 'string') return invalidPayload(ws, msg.type);
      if (apiKey !== undefined && typeof apiKey !== 'string') return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderAdd(ws, {
        id,
        family,
        baseUrl: baseUrl as string | undefined,
        apiKey: apiKey as string | undefined,
      });
      return true;
    }

    case 'provider.remove': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      if (!providerId) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderRemove(ws, providerId);
      return true;
    }

    case 'provider.clear_models': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      if (!providerId) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderClearModels(ws, providerId);
      return true;
    }

    case 'provider.undo_clear': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const previousModels = payload ? optionalStringArray(payload, 'previousModels') : null;
      if (!providerId || !previousModels) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderUndoClear(ws, providerId, previousModels);
      return true;
    }

    case 'provider.update': {
      const payload = asPayloadRecord(msg);
      const id = payload ? requiredString(payload, 'id') : null;
      const envVars = payload ? optionalStringArray(payload, 'envVars') : null;
      const models = payload ? optionalStringArray(payload, 'models') : null;
      if (!payload || !id || envVars === null || models === null) return invalidPayload(ws, msg.type);
      for (const key of ['family', 'baseUrl'] as const) {
        if (payload[key] !== undefined && typeof payload[key] !== 'string') return invalidPayload(ws, msg.type);
      }
      await routes.providerHandlers.handleProviderUpdate(ws, {
        id,
        family: payload['family'] as string | undefined,
        baseUrl: payload['baseUrl'] as string | undefined,
        envVars,
        models,
      });
      return true;
    }

    case 'provider.probe': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const timeoutMs = payload ? optionalNumber(payload, 'timeoutMs') : null;
      if (!providerId || timeoutMs === null) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderProbe(ws, providerId, timeoutMs);
      return true;
    }

    case 'auth.oauth.start': {
      const kind = oauthKind(asPayloadRecord(msg));
      if (!kind) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleOAuthStart(ws, kind);
      return true;
    }

    case 'auth.oauth.code': {
      const payload = asPayloadRecord(msg);
      const kind = oauthKind(payload);
      const input = payload ? requiredString(payload, 'input') : null;
      if (!kind || !input) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleOAuthCode(ws, kind, input);
      return true;
    }

    case 'auth.oauth.cancel': {
      const kind = oauthKind(asPayloadRecord(msg));
      if (!kind) return invalidPayload(ws, msg.type);
      routes.providerHandlers.handleOAuthCancel(ws, kind);
      return true;
    }

    default:
      return false;
  }
}
