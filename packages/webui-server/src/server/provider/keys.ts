import { validateProviderBaseUrl } from '@wrongstack/core/tools';
import type { ProviderConfig } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { errMessage } from '../ws-utils.js';
import {
  addProviderRecord,
  deleteKeyRecord,
  removeProviderRecord,
  setActiveKeyRecord,
  upsertKeyRecord,
} from './keys-records.js';
import type { ProviderServiceContext } from './mutations.js';

/**
 * API-key + provider CRUD surface (6B-2). Moved verbatim from
 * provider-handlers.ts: every handler keeps the load → mutate → save →
 * broadcast ordering and the exact operation_result messages.
 */
export function createKeyHandlers(ctx: ProviderServiceContext) {
  async function handleKeyUpsert(
    ws: WebSocket,
    providerId: string,
    label: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const result = upsertKeyRecord(
        providers,
        providerId,
        label,
        apiKey,
        new Date().toISOString(),
      );
      if (result.ok) {
        await ctx.saveConfigProviders(providers);
        ctx.broadcastSaved(providers);
      }
      ctx.sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  async function handleKeyDelete(ws: WebSocket, providerId: string, label: string): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const result = deleteKeyRecord(providers, providerId, label);
      if (result.ok) {
        await ctx.saveConfigProviders(providers);
        ctx.broadcastSaved(providers);
      }
      ctx.sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  async function handleKeySetActive(
    ws: WebSocket,
    providerId: string,
    label: string,
  ): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const result = setActiveKeyRecord(providers, providerId, label);
      if (result.ok) {
        await ctx.saveConfigProviders(providers);
        ctx.broadcastSaved(providers);
      }
      ctx.sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  return { handleKeyUpsert, handleKeyDelete, handleKeySetActive };
}

/** Provider-level CRUD (add/remove/update/clear/undo-clear). */
export function createProviderCrudHandlers(ctx: ProviderServiceContext) {
  async function handleProviderAdd(
    ws: WebSocket,
    payload: {
      id: string;
      family: string;
      baseUrl?: string | undefined;
      apiKey?: string | undefined;
      models?: string[] | undefined;
      customModels?: ProviderConfig['customModels'] | undefined;
    },
  ): Promise<boolean> {
    try {
      if (payload.baseUrl !== undefined && payload.baseUrl !== '') {
        const invalid = await validateProviderBaseUrl(payload.baseUrl);
        if (invalid) {
          ctx.sendOperationResult(ws, false, invalid);
          return false;
        }
      }
      const providers = await ctx.loadConfigProviders();
      const result = addProviderRecord(providers, payload, new Date().toISOString());
      if (result.ok) {
        await ctx.saveConfigProviders(providers);
        ctx.broadcastSaved(providers);
      }
      ctx.sendOperationResult(ws, result.ok, result.message);
      if (result.ok) {
        ctx.deps.log?.(`[WebUI] Provider "${payload.id}" added via provider.add`);
      }
      return result.ok;
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
      return false;
    }
  }

  async function handleProviderRemove(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const result = removeProviderRecord(providers, providerId);
      if (result.ok) {
        await ctx.saveConfigProviders(providers);
        ctx.broadcastSaved(providers);
      }
      ctx.sendOperationResult(ws, result.ok, result.message);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Remove the saved model allowlist for a provider. */
  async function handleProviderClearModels(ws: WebSocket, providerId: string): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        ctx.sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      delete cfg.models;
      await ctx.saveConfigProviders(providers);
      ctx.sendOperationResult(ws, true, `Cleared model allowlist for ${providerId}`);
      ctx.broadcastSaved(providers);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Restore a previously-cleared model allowlist (pairs with clear). */
  async function handleProviderUndoClear(
    ws: WebSocket,
    providerId: string,
    previousModels: string[],
  ): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const cfg = providers[providerId];
      if (!cfg) {
        ctx.sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      cfg.models = [...previousModels];
      await ctx.saveConfigProviders(providers);
      ctx.sendOperationResult(
        ws,
        true,
        `Restored ${previousModels.length} model(s) for ${providerId}`,
      );
      ctx.broadcastSaved(providers);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Update a saved provider's wire config (family / baseUrl / envVars / models / customModels). */
  async function handleProviderUpdate(
    ws: WebSocket,
    payload: {
      id: string;
      family?: string | undefined;
      baseUrl?: string | undefined;
      envVars?: string[] | undefined;
      models?: string[] | undefined;
      customModels?: ProviderConfig['customModels'] | undefined;
    },
  ): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const cfg = providers[payload.id];
      if (!cfg) {
        ctx.sendOperationResult(ws, false, `Unknown provider "${payload.id}"`);
        return;
      }
      // `provider.probe` sends the saved key to whatever `baseUrl` says and
      // echoes a slice of the response body back over this socket, so an
      // unvalidated write here is both a credential-delivery and a readable-SSRF
      // primitive. `provider_manage` has validated this since WS-013; this path
      // reached the same field without it.
      if (payload.baseUrl !== undefined && payload.baseUrl !== '') {
        const invalid = await validateProviderBaseUrl(payload.baseUrl);
        if (invalid) {
          ctx.sendOperationResult(ws, false, invalid);
          return;
        }
      }
      if (payload.family !== undefined) cfg.family = payload.family as ProviderConfig['family'];
      if (payload.baseUrl !== undefined) cfg.baseUrl = payload.baseUrl;
      if (payload.envVars !== undefined) cfg.envVars = payload.envVars;
      if (payload.models !== undefined) cfg.models = payload.models;
      if (payload.customModels !== undefined) cfg.customModels = payload.customModels;
      await ctx.saveConfigProviders(providers);
      ctx.sendOperationResult(ws, true, `Updated ${payload.id}`);
      ctx.broadcastSaved(providers);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  return {
    handleProviderAdd,
    handleProviderRemove,
    handleProviderClearModels,
    handleProviderUndoClear,
    handleProviderUpdate,
  };
}
