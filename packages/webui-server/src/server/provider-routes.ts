import * as fs from 'node:fs/promises';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import { acpRuntimeValuesError } from '@wrongstack/contracts/types/acp-runtime';
import { parseNativeCloudSettings } from '@wrongstack/core/cloud-provider';
import { modelsDevModelSchema } from '@wrongstack/core/models';
import { getAllProviderQuota, withQuotaPace } from '@wrongstack/core/quota';
import type { WebSocket } from 'ws';
import { correlatedReply } from './correlated-reply.js';
import type { ProviderRouteHandlers } from './provider-route-types.js';
import type { WSClientMessage } from './types.js';
import { runWithOperationRequest, send, sendResult } from './ws-utils.js';

export type { ProviderMutationHandlers, ProviderRouteHandlers } from './provider-route-types.js';

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
async function readAuditTail(file: string, count: number): Promise<Array<Record<string, unknown>>> {
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

/**
 * Upper bound for a client-supplied `provider.probe` timeout, in ms.
 *
 * The probe arms `AbortSignal.timeout(timeoutMs)` on an outbound fetch that
 * carries this provider's saved API key, so `timeoutMs` is a client-chosen
 * request lifetime. `provider.test.run` below already bounds the same field;
 * the probe route reached the sink with only a finiteness check, and the sink's
 * own ceiling is `2_147_483_647` ms — the maximum legal timer, ~24.8 days — so
 * a hostile frame pinned a credential-bearing request (and this connection's
 * sequential message dispatch) for that whole window. `0` is still accepted: it
 * is the CLI probe wrapper's documented "use the default timeout" spelling.
 */
const MAX_PROBE_TIMEOUT_MS = 120_000;
const SAFE_CONFIG_KEY = /^(?!__proto__$|prototype$|constructor$)[^\u0000-\u001f]{1,256}$/;
const CUSTOM_MODEL_BOOLEAN_CAPS = new Set([
  'tools',
  'vision',
  'reasoning',
  'streaming',
  'jsonMode',
]);
const INLINE_DEFINITION_KEYS = new Set([
  'name',
  'maxOutput',
  'capabilities',
  'provider',
  'modelsDev',
]);

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

function oauthKind(payload: Record<string, unknown> | null): string | null {
  const kind = payload?.['kind'];
  return typeof kind === 'string' && SAFE_CONFIG_KEY.test(kind) ? kind : null;
}

export async function handleProviderRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  routes: ProviderRouteHandlers,
): Promise<boolean> {
  if (msg.type === 'providers.list')
    ws = correlatedReply(ws, msg.payload, ['provider.catalog', 'key.operation_result']).socket;
  else if (
    msg.type === 'providers.saved' ||
    msg.type === 'provider.models' ||
    msg.type === 'acp.config_options'
  )
    ws = correlatedReply(ws, msg.payload, [msg.type, 'key.operation_result']).socket;
  else if (msg.type.startsWith('auth.oauth.'))
    ws = correlatedReply(ws, msg.payload, [
      'auth.oauth.providers',
      'auth.oauth.status',
      'key.operation_result',
    ]).socket;
  else if (msg.type === 'provider.models.search')
    ws = correlatedReply(ws, msg.payload, [
      'provider.models.search_result',
      'key.operation_result',
    ]).socket;
  else if (msg.type === 'provider.quota.get' || msg.type === 'provider.quota.refresh')
    ws = correlatedReply(ws, msg.payload, ['provider.quota', 'key.operation_result']).socket;
  else if (msg.type === 'provider.status.get')
    ws = correlatedReply(ws, msg.payload, [
      'provider.status.snapshot',
      'key.operation_result',
    ]).socket;
  else if (msg.type === 'provider.audit.get')
    ws = correlatedReply(ws, msg.payload, [
      'provider.audit.history',
      'key.operation_result',
    ]).socket;
  const payload = asPayloadRecord(msg);
  const requestId = typeof payload?.['requestId'] === 'string' ? payload['requestId'] : undefined;
  return runWithOperationRequest(requestId, () => dispatchProviderRoute(ws, msg, routes));
}

async function dispatchProviderRoute(
  ws: WebSocket,
  msg: WSClientMessage,
  routes: ProviderRouteHandlers,
): Promise<boolean> {
  switch (msg.type) {
    case 'acp.config_options': {
      const payload = asPayloadRecord(msg);
      const agentId = payload && requiredString(payload, 'agentId');
      const values = payload?.['values'] ?? {};
      if (!agentId || acpRuntimeValuesError(values)) {
        send(ws, {
          type: 'acp.config_options',
          payload: {
            ok: false,
            error: acpRuntimeValuesError(values) ?? 'An ACP agent id is required',
          },
        });
        return true;
      }
      try {
        if (!routes.acpConfigOptions) throw new Error('ACP settings are unavailable in this host');
        send(ws, {
          type: 'acp.config_options',
          payload: {
            ok: true,
            ...((await routes.acpConfigOptions(
              agentId,
              values as Record<string, string>,
            )) as object),
          },
        });
      } catch (error) {
        send(ws, {
          type: 'acp.config_options',
          payload: {
            ok: false,
            agentId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return true;
    }
    case 'providers.list':
      await routes.listProviders(ws, msg);
      return true;
    case 'providers.saved':
      await routes.listSavedProviders(ws, msg);
      return true;
    case 'provider.models': {
      // A payload-less frame is decoder-legal for client messages, but both
      // route adapters dereference `payload.providerId`. Validate here like
      // every other payload-bearing case so the client gets the invalid
      // result frame instead of a throw past the dispatcher (which only
      // logs it — the asking tab would get no answer at all).
      const payload = asPayloadRecord(msg);
      if (!payload || !requiredString(payload, 'providerId')) {
        return invalidPayload(ws, msg.type);
      }
      await routes.listProviderModels(ws, msg);
      return true;
    }
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
    case 'fallback.suggest':
      await routes.suggestFallbacks(ws, msg);
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
      const providerType = payload?.['type'];
      const models = payload ? optionalStringArray(payload, 'models') : null;
      const customModels = payload ? optionalCustomModels(payload) : null;
      if (!id || !SAFE_CONFIG_KEY.test(id) || !family) return invalidPayload(ws, msg.type);
      if (
        providerType !== undefined &&
        (typeof providerType !== 'string' || !SAFE_CONFIG_KEY.test(providerType))
      )
        return invalidPayload(ws, msg.type);
      if (baseUrl !== undefined && typeof baseUrl !== 'string') return invalidPayload(ws, msg.type);
      if (apiKey !== undefined && typeof apiKey !== 'string') return invalidPayload(ws, msg.type);
      if (models === null || customModels === null) return invalidPayload(ws, msg.type);
      const added = await routes.providerHandlers.handleProviderAdd(ws, {
        id,
        ...(providerType !== undefined ? { type: providerType as string } : {}),
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
      if (
        !payload ||
        !id ||
        !SAFE_CONFIG_KEY.test(id) ||
        envVars === null ||
        models === null ||
        customModels === null
      )
        return invalidPayload(ws, msg.type);
      for (const key of ['family', 'baseUrl'] as const) {
        if (payload[key] !== undefined && typeof payload[key] !== 'string')
          return invalidPayload(ws, msg.type);
      }
      let cloud: ProviderConfig['cloud'];
      try {
        if (payload['cloud'] !== undefined) cloud = parseNativeCloudSettings(payload['cloud']);
      } catch {
        return invalidPayload(ws, msg.type);
      }
      await routes.providerHandlers.handleProviderUpdate(ws, {
        id,
        cloud,
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
      // `timeoutMs` is refused, not clamped: it becomes the lifetime of a
      // server-side request that carries this provider's saved API key, so
      // guessing a different value would silently change the probe the operator
      // asked for. Rejecting the frame is the same contract `provider.test.run`
      // already applies to this field.
      if (
        !providerId ||
        !SAFE_CONFIG_KEY.test(providerId) ||
        timeoutMs === null ||
        (typeof timeoutMs === 'number' &&
          (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_PROBE_TIMEOUT_MS))
      )
        return invalidPayload(ws, msg.type);
      await routes.providerHandlers.handleProviderProbe(ws, providerId, timeoutMs);
      return true;
    }

    case 'provider.test.run': {
      const payload = asPayloadRecord(msg);
      const requestId = payload ? requiredString(payload, 'requestId') : null;
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const modelIds = payload ? optionalStringArray(payload, 'modelIds') : null;
      const timeoutMs = payload ? optionalNumber(payload, 'timeoutMs') : null;
      const maxTokens = payload ? optionalNumber(payload, 'maxTokens') : null;
      if (
        !requestId ||
        !SAFE_CONFIG_KEY.test(requestId) ||
        !providerId ||
        !SAFE_CONFIG_KEY.test(providerId) ||
        !modelIds ||
        modelIds.length === 0 ||
        modelIds.length > 200 ||
        modelIds.some((modelId) => !SAFE_CONFIG_KEY.test(modelId)) ||
        timeoutMs === null ||
        maxTokens === null ||
        (timeoutMs !== undefined &&
          (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000)) ||
        (maxTokens !== undefined &&
          (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4_096))
      ) {
        return invalidPayload(ws, msg.type);
      }
      void routes.providerHandlers.handleProviderModelTestRun(ws, {
        requestId,
        providerId,
        modelIds: [...new Set(modelIds)],
        timeoutMs: timeoutMs ?? 45_000,
        maxTokens: maxTokens ?? 32,
      });
      return true;
    }

    case 'provider.test.cancel': {
      const payload = asPayloadRecord(msg);
      const requestId = payload ? requiredString(payload, 'requestId') : null;
      if (!requestId || !SAFE_CONFIG_KEY.test(requestId)) return invalidPayload(ws, msg.type);
      routes.providerHandlers.handleProviderModelTestCancel(requestId);
      return true;
    }

    case 'auth.oauth.list': {
      routes.providerHandlers.handleOAuthList(ws);
      return true;
    }

    case 'auth.oauth.start': {
      const payload = asPayloadRecord(msg);
      const kind = oauthKind(payload);
      const providerId = payload?.['providerId'];
      const strategyId = kind ? routes.providerHandlers.resolveOAuthStrategyId(kind) : undefined;
      const attemptId = payload?.['attemptId'];
      if (
        attemptId !== undefined &&
        (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(attemptId))
      )
        return invalidPayload(ws, msg.type);
      if (!strategyId) return invalidPayload(ws, msg.type);
      if (
        providerId !== undefined &&
        (typeof providerId !== 'string' || !SAFE_CONFIG_KEY.test(providerId))
      ) {
        return invalidPayload(ws, msg.type);
      }
      if (typeof attemptId === 'string')
        await routes.providerHandlers.handleOAuthStart(ws, strategyId, providerId, attemptId);
      else await routes.providerHandlers.handleOAuthStart(ws, strategyId, providerId);
      return true;
    }

    case 'auth.oauth.code': {
      const payload = asPayloadRecord(msg);
      const kind = oauthKind(payload);
      const input = payload ? requiredString(payload, 'input') : null;
      const strategyId = kind ? routes.providerHandlers.resolveOAuthStrategyId(kind) : undefined;
      const attemptId = payload?.['attemptId'];
      if (
        attemptId !== undefined &&
        (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(attemptId))
      )
        return invalidPayload(ws, msg.type);
      if (!strategyId || !input) return invalidPayload(ws, msg.type);
      if (typeof attemptId === 'string')
        await routes.providerHandlers.handleOAuthCode(ws, strategyId, input, attemptId);
      else await routes.providerHandlers.handleOAuthCode(ws, strategyId, input);
      return true;
    }

    case 'auth.oauth.cancel': {
      const kind = oauthKind(asPayloadRecord(msg));
      const strategyId = kind ? routes.providerHandlers.resolveOAuthStrategyId(kind) : undefined;
      const attemptId = asPayloadRecord(msg)?.['attemptId'];
      if (
        attemptId !== undefined &&
        (typeof attemptId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(attemptId))
      )
        return invalidPayload(ws, msg.type);
      if (!strategyId) return invalidPayload(ws, msg.type);
      if (typeof attemptId === 'string')
        routes.providerHandlers.handleOAuthCancel(ws, strategyId, attemptId);
      else routes.providerHandlers.handleOAuthCancel(ws, strategyId);
      return true;
    }

    case 'provider.quota.refresh': {
      // Unlike `.get`, this asks the vendors — but only the ones whose quota
      // lives on a free account endpoint (MiniMax, Z.AI). Header-metered plans
      // are never probed: that would spend a request of the plan being checked.
      await routes.providerHandlers.handleProviderQuotaRefresh(ws);
      return true;
    }

    case 'provider.quota.get': {
      // A tab that connects mid-session has missed every push so far, and the
      // reading is never re-fetched from the provider — asking a metered plan
      // "how much have I spent" costs a request. Replaying what the store
      // already holds is the only way a late tab sees anything before the next
      // turn completes.
      send(ws, {
        type: 'provider.quota',
        payload: { snapshots: withQuotaPace(getAllProviderQuota()) },
      });
      return true;
    }

    case 'provider.status.get': {
      await routes.prepareProviderStatus?.();
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
      await routes.prepareProviderStatus?.();
      if (!routes.statusTracker) {
        sendResult(ws, false, 'provider.status.retry: tracker not available');
        return true;
      }
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const model = payload ? requiredString(payload, 'model') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !model)
        return invalidPayload(ws, msg.type);
      const before = routes.statusTracker.getStatus(providerId, model);
      const released = routes.statusTracker.retryNow(providerId, model);
      if (released)
        await routes.persistProviderStatusControl?.(providerId, model, before, 'manual_retry');
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
      await routes.prepareProviderStatus?.();
      if (!routes.statusTracker) {
        sendResult(ws, false, 'provider.status.clear: tracker not available');
        return true;
      }
      const payload = asPayloadRecord(msg);
      const providerId = payload ? requiredString(payload, 'providerId') : null;
      const model = payload ? requiredString(payload, 'model') : null;
      if (!providerId || !SAFE_CONFIG_KEY.test(providerId) || !model)
        return invalidPayload(ws, msg.type);
      const before = routes.statusTracker.getStatus(providerId, model);
      routes.statusTracker.clear(providerId, model);
      await routes.persistProviderStatusControl?.(providerId, model, before, 'manual_clear');
      sendResult(ws, true, `Cleared tracking for ${providerId}/${model}.`);
      return true;
    }

    default:
      return false;
  }
}
