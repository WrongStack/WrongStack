import type { ProviderConfig } from '@wrongstack/core/types';
import type { WebSocket } from 'ws';
import { errMessage } from '../ws-utils.js';
import type { ProviderServiceContext } from './mutations.js';

/**
 * Custom model definition CRUD (ME-3, 6B-2). Moved verbatim from
 * provider-handlers.ts: own-property lookups (Object.hasOwn — prototype
 * pollution guard) and the models[] allowlist sync semantics.
 */
export function createCustomModelHandlers(ctx: ProviderServiceContext) {
  /** Set/update a single custom model definition for a provider (ME-3). */
  async function handleCustomModelSet(
    ws: WebSocket,
    providerId: string,
    modelId: string,
    definition: NonNullable<ProviderConfig['customModels']>[string],
  ): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const cfg = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
      if (!cfg) {
        ctx.sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      if (!cfg.customModels) cfg.customModels = {};
      cfg.customModels[modelId] = definition;
      // ME-3 follow-up: keep the models[] allowlist in sync so a newly
      // added custom model is visible in pickers/providers.saved and an
      // existing one stays listed. Add when absent; never remove here
      // (set is upsert, not delete).
      if (!cfg.models) cfg.models = [];
      if (!cfg.models.includes(modelId)) cfg.models.push(modelId);
      await ctx.saveConfigProviders(providers);
      ctx.sendOperationResult(ws, true, `Saved model "${modelId}" for ${providerId}`);
      ctx.broadcastSaved(providers);
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  /** Remove a single custom model entry for a provider (ME-3). */
  async function handleCustomModelRemove(
    ws: WebSocket,
    providerId: string,
    modelId: string,
  ): Promise<void> {
    try {
      const providers = await ctx.loadConfigProviders();
      const cfg = Object.hasOwn(providers, providerId) ? providers[providerId] : undefined;
      if (!cfg) {
        ctx.sendOperationResult(ws, false, `Unknown provider "${providerId}"`);
        return;
      }
      if (cfg.customModels && Object.hasOwn(cfg.customModels, modelId)) {
        delete cfg.customModels[modelId];
        if (Object.keys(cfg.customModels).length === 0) delete cfg.customModels;
        // ME-3 follow-up: keep the models[] allowlist in sync — a removed
        // custom model should no longer appear in pickers/providers.saved.
        if (cfg.models) {
          cfg.models = cfg.models.filter((m) => m !== modelId);
          if (cfg.models.length === 0) delete cfg.models;
        }
        await ctx.saveConfigProviders(providers);
        ctx.sendOperationResult(ws, true, `Removed model "${modelId}" from ${providerId}`);
        ctx.broadcastSaved(providers);
      } else {
        ctx.sendOperationResult(ws, false, `Model "${modelId}" not found in ${providerId}`);
      }
    } catch (err) {
      ctx.sendOperationResult(ws, false, errMessage(err));
    }
  }

  return { handleCustomModelSet, handleCustomModelRemove };
}
