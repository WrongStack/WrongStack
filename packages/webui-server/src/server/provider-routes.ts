import * as fs from 'node:fs/promises';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import { modelsDevModelSchema } from '@wrongstack/core/models';
import type { ProviderConfig } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import type { WSClientMessage } from './types.js';
import { send, sendResult } from './ws-utils.js';

type OAuthKind = 'chatgpt' | 'claude' | 'copilot';

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
  handleOAuthStart: (
    ws: WebSocket,
    kind: OAuthKind,
    providerId?: string | undefined,
  ) => Promise<void>;
  handleOAuthCode: (ws: WebSocket, kind: OAuthKind, input: string) => Promise<void>;
  handleOAuthCancel: (ws: WebSocket, kind: OAuthKind) => void;
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
  /** Adopt a just-added provider as the live default when no model is active. */
  adoptDefaultProviderIfUnset: (providerId: string) => Promise<void>;
  providerHandlers: ProviderMutationHandlers;
  /** Live provider/model health tracker (the "waiting room"). Undefined when
   * the host is not wired with a tracker (e.g. test harnesses). */
  statusTracker?: ProviderModelStatusTracker | undefined;
  /** Durable block/open audit trail (JSONL) next to the profile config.
   * Undefined when the host did not provide a profile path (test harnesses). */
  providerAuditFile?: string | undefined;
}

function asPayloadRecord(msg: WSClientMessage): Record<string, unknown> | null {
  const payload = msg.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tail the durable block/open audit trail (JSONL), newest first. Torn or
 * corrupt lines are skipped — the audit trail is best-effort by design. */
async function readAuditTail(
  file: string,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return [];
  }
  const lines: Array<Record<string, unknown>> = [];
  for (const line of raw.trim().split('\n')) {
    if (!line) continue;
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Skip torn/corrupt lines.
    }
  }
  return lines.slice(-count).reverse();
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

function optionalStringArray(
  payload: Record<string, unknown>,
  key: string,
): string[] | undefined | null {
  const value = payload[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

const SAFE_CONFIG_KEY = /^(?!__proto__$|prototype$|constructor$)[^\u0000-\u001f]{1,256}$/;
const CUSTOM_MODEL_BOOLEAN_CAPS = new Set([
  'tools',
  'vision',
  'reasoning',
  'streaming',
  'jsonMode',
]);
const INLINE_DEFINITION_KEYS = new Set(['name', 'maxOutput', 'capabilities', 'provider', 'modelsDev']);

function optionalCustomModels(
  payload: Record<string, unknown>,
): ProviderConfig['customModels'] | undefined | null {
  const value = payload['customModels'];
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: NonNullable<ProviderConfig['customModels']> = Object.create(null) as NonNullable<
    ProviderConfig['customModels']
  >;
  for (const [modelId, rawDefinition] of Object.entries(value)) {
    if (!SAFE_CONFIG_KEY.test(modelId)) return null;
    if (
      typeof rawDefinition !== 'object' ||
      rawDefinition === null ||
      Array.isArray(rawDefinition)
    ) {
      return null;
    }
    const definition = rawDefinition as Record<string, unknown>;
    if (Object.keys(definition).some((key) => !INLINE_DEFINITION_KEYS.has(key))) return null;
    if (definition['name'] !== undefined && typeof definition['name'] !== 'string') return null;
    if (definition['provider'] !== undefined && typeof definition['provider'] !== 'string')
      return null;
    if (
      definition['maxOutput'] !== undefined &&
      (typeof definition['maxOutput'] !== 'number' ||
        !Number.isFinite(definition['maxOutput']) ||
        definition['maxOutput'] <= 0)
    ) {
      return null;
    }
    const rawCaps = definition['capabilities'];
    let capabilities:
      | NonNullable<ProviderConfig['customModels']>[string]['capabilities']
      | undefined;
    if (rawCaps !== undefined) {
      if (typeof rawCaps !== 'object' || rawCaps === null || Array.isArray(rawCaps)) return null;
      const entry = rawCaps as Record<string, unknown>;
      const allowedCaps = new Set([...CUSTOM_MODEL_BOOLEAN_CAPS, 'maxContext', 'maxOutput']);
      if (Object.keys(entry).some((key) => !allowedCaps.has(key))) return null;
      const built: Partial<{
        maxContext: number;
        maxOutput: number;
        tools: boolean;
        vision: boolean;
        reasoning: boolean;
        streaming: boolean;
        jsonMode: boolean;
      }> = {};
      for (const [key, capValue] of Object.entries(entry)) {
        if (CUSTOM_MODEL_BOOLEAN_CAPS.has(key)) {
          if (typeof capValue !== 'boolean') return null;
          (built as Record<string, unknown>)[key] = capValue;
        } else if (typeof capValue !== 'number' || !Number.isFinite(capValue) || capValue <= 0) {
          return null;
        } else {
          (built as Record<string, unknown>)[key] = capValue;
        }
      }
      capabilities = built;
    }
    // ME-3: validate modelsDev BEFORE building the result object so that
    // an invalid value rejects the whole entry (returning null), not
    // silently drops. Spreading null into an object literal is a JS no-op.
    const rawMd = definition['modelsDev'];
    let validatedModelsDev: Record<string, unknown> | undefined;
    if (rawMd !== undefined) {
      if (!isRecord(rawMd)) return null;
      const parsed = modelsDevModelSchema.safeParse({ ...rawMd, id: modelId });
      if (!parsed.success) return null;
      const { id: _parsedId, ...validMd } = parsed.data;
      validatedModelsDev = validMd as Record<string, unknown>;
    }
    out[modelId] = {
      ...(typeof definition['name'] === 'string' ? { name: definition['name'] } : {}),
      ...(typeof definition['provider'] === 'string' ? { provider: definition['provider'] } : {}),
      ...(typeof definition['maxOutput'] === 'number'
        ? { maxOutput: definition['maxOutput'] }
        : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(validatedModelsDev ? { modelsDev: validatedModelsDev } : {}),
    };
  }
  return out;
}

function invalidPayload(ws: WebSocket, type: string): true {
  sendResult(ws, false, `${type} payload is invalid`);
  return true;
}

const OAUTH_KINDS = new Set(['chatgpt', 'claude', 'copilot']);
function oauthKind(
  payload: Record<string, unknown> | null,
): 'chatgpt' | 'claude' | 'copilot' | null {
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
    case 'provider.models.search': {
      const payload = asPayloadRecord(msg);
      const query = payload ? requiredString(payload, 'query') : null;
      const limit = payload ? optionalNumber(payload, 'limit') : null;
      if (
        !query ||
        limit === null ||
        (limit !== undefined && (limit <= 0 || !Number.isInteger(limit)))
      ) {
        return invalidPayload(ws, msg.type);
      }
      await routes.searchProviderModels(ws, query, limit);
      return true;
    }
    case 'model.switch':
      await routes.switchModel(ws, msg);
      return true;
    case 'model.refine':
      await routes.refineModel(ws, msg);
      return true;
    case 'model.fallback_choice':
      await routes.fallbackChoice(ws, msg);
      return true;

    case 'key.add':
    case 'key.update': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const label = payload ? requiredString(payload, 'label') : null;
      const apiKey = payload ? requiredString(payload, 'apiKey') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !label || !apiKey)
        return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleKeyUpsert(ws, providerId, label, apiKey);
      return true;
    }

    case 'key.delete': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const label = payload ? requiredString(payload, 'label') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !label)
        return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleKeyDelete(ws, providerId, label);
      return true;
    }

    case 'key.set_active': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const label = payload ? requiredString(payload, 'label') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !label)
        return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleKeySetActive(ws, providerId, label);
      return true;
    }

    case 'provider.add': {
      const payload = asPayloadRecord(msg);
      const id = payload ? requiredString(payload, 'id') : null;
      const family = payload ? requiredString(payload, 'family') : null;
      const baseUrl = payload?.['baseUrl'];
      const apiKey = payload?.['apiKey'];
      const models = payload ? optionalStringArray(payload, 'models') : null;
      const customModels = payload ? optionalCustomModels(payload) : null;
      if (!id || !SAFE_CONFIG_KEY.test(id) || !family) return invalidPayload(ws, msg.type);
      if (baseUrl !== undefined && typeof baseUrl !== 'string') return invalidPayload(ws, msg.type);
      if (apiKey !== undefined && typeof apiKey !== 'string') return invalidPayload(ws, msg.type);
      if (models === null || customModels === null) return invalidPayload(ws, msg.type);
      const added = await routes.providerHandlers.handleProviderAdd(ws, {
        id,
        family,
        baseUrl: baseUrl as string | undefined,
        apiKey: apiKey as string | undefined,
        models,
        customModels,
      });
      // Adopt the just-added provider as the live default when nothing is
      // active yet — parity with the boot auto-select (immediately usable).
      // Only when the add actually succeeded, and fire-and-forget so the
      // adoption probe cannot stall this connection's sequential message
      // handler. Best-effort: a failed adoption must not surface here.
      if (added) {
        void routes.adoptDefaultProviderIfUnset(id).catch(() => undefined);
      }
      return true;
    }

    case 'provider.remove': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId)) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderRemove(ws, providerId);
      return true;
    }

    case 'provider.clear_models': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId)) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderClearModels(ws, providerId);
      return true;
    }

    case 'provider.custom_models.set': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const modelId = payload ? requiredString(payload, 'modelId') : null;
      if (
        !payload ||
        !providerId ||
        !SAFE_CONFIG_KEY.test(providerId) ||
        !modelId ||
        !SAFE_CONFIG_KEY.test(modelId)
      ) {
        return invalidPayload(ws, msg.type);
      }
      const customModelRaw = payload['customModel'];
      if (!isRecord(customModelRaw)) return invalidPayload(ws, msg.type);
      // Reuse optionalCustomModels by wrapping in the expected shape.
      const cm = optionalCustomModels({ customModels: { [modelId]: customModelRaw } });
      if (!cm?.[modelId]) return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleCustomModelSet(ws, providerId, modelId, cm[modelId]!);
      return true;
    }

    case 'provider.custom_models.remove': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const modelId = payload ? requiredString(payload, 'modelId') : null;
      if (
        !payload ||
        !providerId ||
        !SAFE_CONFIG_KEY.test(providerId) ||
        !modelId ||
        !SAFE_CONFIG_KEY.test(modelId)
      ) {
        return invalidPayload(ws, msg.type);
      }
      await routes.providerHandlers.handleCustomModelRemove(ws, providerId, modelId);
      return true;
    }

    case 'provider.undo_clear': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const previousModels = payload ? optionalStringArray(payload, 'previousModels') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !previousModels)
        return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderUndoClear(ws, providerId, previousModels);
      return true;
    }

    case 'provider.update': {
      const payload = asPayloadRecord(msg);
      const id = payload ? requiredString(payload, 'id') : null;
      const envVars = payload ? optionalStringArray(payload, 'envVars') : null;
      const models = payload ? optionalStringArray(payload, 'models') : null;
      const customModels = payload ? optionalCustomModels(payload) : null;
      if (!payload || !id || !SAFE_CONFIG_KEY.test(id) || envVars === null || models === null || customModels === null)
        return invalidPayload(ws, msg.type);
      for (const key of ['family', 'baseUrl'] as const) {
        if (payload[key] !== undefined && typeof payload[key] !== 'string')
          return invalidPayload(ws, msg.type);
      }
      await routes.providerHandlers.handleProviderUpdate(ws, {
        id,
        family: payload['family'] as string | undefined,
        baseUrl: payload['baseUrl'] as string | undefined,
        envVars,
        models,
        customModels,
      });
      return true;
    }

    case 'provider.probe': {
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const timeoutMs = payload ? optionalNumber(payload, 'timeoutMs') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || timeoutMs === null)
        return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderProbe(ws, providerId, timeoutMs);
      return true;
    }

    case 'auth.oauth.start': {
      const payload = asPayloadRecord(msg);
      const kind = oauthKind(payload);
      const providerId = payload?.['providerId'];
      if (!kind) return invalidPayload(ws, msg.type);
      if (
        providerId !== undefined &&
        (typeof providerId !== 'string' || !SAFE_CONFIG_KEY.test(providerId))
      ) {
        return invalidPayload(ws, msg.type);
      }
      await routes.providerHandlers.handleOAuthStart(ws, kind, providerId);
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

    case 'provider.status.get': {
      if (!routes.statusTracker) {
        send(ws, { type: 'provider.status.snapshot', payload: { error: 'not_available' } });
        return true;
      }
      send(ws, {
        type: 'provider.status.snapshot',
        payload: routes.statusTracker.getSnapshot(),
      });
      return true;
    }

    case 'provider.audit.get': {
      // Strict string check: test-harness stubs may auto-fill this optional
      // field with non-strings, and fs.readFile would throw on those.
      const auditFile = routes.providerAuditFile;
      if (typeof auditFile !== 'string' || auditFile.length === 0) {
        send(ws, { type: 'provider.audit.history', payload: { lines: [] } });
        return true;
      }
      const auditPayload = asPayloadRecord(msg);
      const requested = auditPayload ? optionalNumber(auditPayload, 'count') : undefined;
      const count = Math.min(Math.max(Math.trunc(requested ?? 20) || 20, 1), 200);
      const lines = await readAuditTail(auditFile, count);
      send(ws, { type: 'provider.audit.history', payload: { lines } });
      return true;
    }

    case 'provider.status.retry': {
      if (!routes.statusTracker) {
        sendResult(ws, false, 'provider.status.retry: tracker not available');
        return true;
      }
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const model = payload ? requiredString(payload, 'model') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !model)
        return invalidPayload(ws, msg.type);
      const released = routes.statusTracker.retryNow(providerId, model);
      sendResult(
        ws,
        true,
        released
          ? `Released ${providerId}/${model} for a half-open probe on its next use.`
          : `${providerId}/${model} is not currently in the waiting room.`,
      );
      return true;
    }

    case 'provider.status.clear': {
      if (!routes.statusTracker) {
        sendResult(ws, false, 'provider.status.clear: tracker not available');
        return true;
      }
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const model = payload ? requiredString(payload, 'model') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !model)
        return invalidPayload(ws, msg.type);
      routes.statusTracker.clear(providerId, model);
      sendResult(ws, true, `Cleared tracking for ${providerId}/${model}.`);
      return true;
    }

    default:
      return false;
  }
}
