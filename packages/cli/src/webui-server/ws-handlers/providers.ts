import type { ProviderConfig } from '@wrongstack/core';
import type { WebSocket } from 'ws';
import {
  expectDefined,
  maskedKey,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../../provider-config-utils.js';
import { loadSavedProviders, saveProviders } from '../provider-config.js';
import type { WsHandlerContext } from './index.js';

/**
 * PR 5 of Issue #30: provider / model / API-key WebSocket handlers.
 *
 * Extracted verbatim from the `runWebUI` closure in webui-server.ts.
 * Every former closure capture (`opts.modelsRegistry`,
 * `opts.globalConfigPath`, `send`, `broadcast`, `console.log`) is now a
 * field on `ctx: WsHandlerContext` — no hidden state.
 */

/**
 * Module-private result helper. webui-server.ts keeps its own
 * `sendResult` (used by ~80 other switch cases); this is the
 * provider-group copy so these handlers don't depend on it.
 */
function sendResult(ctx: WsHandlerContext, ws: WebSocket, success: boolean, message: string): void {
  ctx.send(ws, { type: 'key.operation_result', payload: { success, message } });
}

export async function handleProvidersList(ctx: WsHandlerContext, ws: WebSocket): Promise<void> {
  if (!ctx.modelsRegistry) {
    sendResult(ctx, ws, false, 'Models registry not available');
    return;
  }
  try {
    const providers = await ctx.modelsRegistry.listProviders();
    const savedProviders = await loadSavedProviders(ctx.globalConfigPath);
    const savedIds = new Set(Object.keys(savedProviders));

    ctx.send(ws, {
      type: 'provider.catalog',
      payload: {
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          family: p.family,
          apiBase: p.apiBase,
          envVars: p.envVars,
          modelCount: p.models.length,
          hasApiKey: savedIds.has(p.id) || p.envVars.some((v) => !!process.env[v]),
        })),
      },
    });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleProviderModels(
  ctx: WsHandlerContext,
  ws: WebSocket,
  providerId: string,
): Promise<void> {
  if (!ctx.modelsRegistry) {
    sendResult(ctx, ws, false, 'Models registry not available');
    return;
  }
  try {
    const provider = await ctx.modelsRegistry.getProvider(providerId);
    if (!provider) {
      sendResult(ctx, ws, false, `Provider "${providerId}" not found in catalog`);
      return;
    }
    ctx.send(ws, {
      type: 'provider.models',
      payload: {
        provider: providerId,
        models: provider.models.map((m) => ({
          id: m.id,
          name: m.name,
          releaseDate: m.release_date,
          contextWindow: m.limit?.context,
          inputCost: m.cost?.input,
          outputCost: m.cost?.output,
          capabilities: [
            ...(m.tool_call ? ['tools'] : []),
            ...(m.reasoning ? ['reasoning'] : []),
            ...(m.modalities?.input?.includes('image') ? ['vision'] : []),
            ...(m.open_weights ? ['open_weights'] : []),
          ],
        })),
      },
    });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleProvidersSaved(ctx: WsHandlerContext, ws: WebSocket): Promise<void> {
  try {
    const providers = await loadSavedProviders(ctx.globalConfigPath);
    ctx.send(ws, {
      type: 'providers.saved',
      payload: {
        providers: Object.entries(providers).map(([id, cfg]) => ({
          id,
          family: cfg.family,
          baseUrl: cfg.baseUrl,
          apiKeys: normalizeKeys(cfg).map((k) => ({
            label: k.label,
            maskedKey: maskedKey(k.apiKey),
            isActive: k.label === cfg.activeKey,
            createdAt: k.createdAt,
          })),
        })),
      },
    });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleKeyUpsert(
  ctx: WsHandlerContext,
  ws: WebSocket,
  providerId: string,
  label: string,
  apiKey: string,
): Promise<void> {
  try {
    const providers = await loadSavedProviders(ctx.globalConfigPath);
    const existing = providers[providerId] ?? { type: providerId };
    const keys = normalizeKeys(existing);

    // Check if label exists
    const existingIdx = keys.findIndex((k) => k.label === label);
    if (existingIdx >= 0) {
      keys[existingIdx] = { ...expectDefined(keys[existingIdx]), apiKey, createdAt: nowIso() };
    } else {
      keys.push({ label, apiKey, createdAt: nowIso() });
    }

    writeKeysBack(existing, keys);
    if (!existing.activeKey) existing.activeKey = label;
    providers[providerId] = existing;

    await saveProviders(ctx.globalConfigPath, providers);
    sendResult(ctx, ws, true, `Key "${label}" saved for ${providerId}`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleKeyDelete(
  ctx: WsHandlerContext,
  ws: WebSocket,
  providerId: string,
  label: string,
): Promise<void> {
  try {
    const providers = await loadSavedProviders(ctx.globalConfigPath);
    const existing = providers[providerId];
    if (!existing) {
      sendResult(ctx, ws, false, `Provider "${providerId}" not found`);
      return;
    }
    const keys = normalizeKeys(existing).filter((k) => k.label !== label);
    if (keys.length === 0) {
      delete providers[providerId];
    } else {
      writeKeysBack(existing, keys);
      if (existing.activeKey === label) {
        existing.activeKey = keys[0]?.label;
      }
      providers[providerId] = existing;
    }
    await saveProviders(ctx.globalConfigPath, providers);
    sendResult(ctx, ws, true, `Key "${label}" deleted from ${providerId}`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleKeySetActive(
  ctx: WsHandlerContext,
  ws: WebSocket,
  providerId: string,
  label: string,
): Promise<void> {
  try {
    const providers = await loadSavedProviders(ctx.globalConfigPath);
    const existing = providers[providerId];
    if (!existing) {
      sendResult(ctx, ws, false, `Provider "${providerId}" not found`);
      return;
    }
    existing.activeKey = label;
    writeKeysBack(existing, normalizeKeys(existing));
    providers[providerId] = existing;
    await saveProviders(ctx.globalConfigPath, providers);
    sendResult(ctx, ws, true, `Active key for ${providerId} set to "${label}"`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleProviderAdd(
  ctx: WsHandlerContext,
  ws: WebSocket,
  payload: {
    id: string;
    family: string;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
  },
): Promise<void> {
  try {
    const providers = await loadSavedProviders(ctx.globalConfigPath);
    if (providers[payload.id]) {
      sendResult(
        ctx,
        ws,
        false,
        `Provider "${payload.id}" already exists. Use key.add to add a key.`,
      );
      return;
    }
    const newProv: ProviderConfig = {
      type: payload.id,
      family: payload.family as ProviderConfig['family'],
      baseUrl: payload.baseUrl,
    };
    if (payload.apiKey) {
      newProv.apiKeys = [{ label: 'default', apiKey: payload.apiKey, createdAt: nowIso() }];
      newProv.activeKey = 'default';
    }
    providers[payload.id] = newProv;
    await saveProviders(ctx.globalConfigPath, providers);
    sendResult(ctx, ws, true, `Provider "${payload.id}" added`);
    ctx.log(`[WebUI] Provider "${payload.id}" added via provider.add`);
    ctx.broadcast({
      type: 'providers.saved',
      payload: {
        providers: Object.entries(providers).map(([id, cfg]) => ({
          id,
          family: cfg.family,
          baseUrl: cfg.baseUrl,
          apiKeys: normalizeKeys(cfg).map((k) => ({
            label: k.label,
            maskedKey: maskedKey(k.apiKey),
            isActive: k.label === cfg.activeKey,
            createdAt: k.createdAt,
          })),
        })),
      },
    });
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}

export async function handleProviderRemove(
  ctx: WsHandlerContext,
  ws: WebSocket,
  providerId: string,
): Promise<void> {
  try {
    const providers = await loadSavedProviders(ctx.globalConfigPath);
    if (!providers[providerId]) {
      sendResult(ctx, ws, false, `Provider "${providerId}" not found`);
      return;
    }
    delete providers[providerId];
    await saveProviders(ctx.globalConfigPath, providers);
    sendResult(ctx, ws, true, `Provider "${providerId}" removed`);
  } catch (err) {
    sendResult(ctx, ws, false, err instanceof Error ? err.message : String(err));
  }
}
