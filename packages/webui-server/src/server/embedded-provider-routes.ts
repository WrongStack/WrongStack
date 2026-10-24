import * as path from 'node:path';
import type { ProviderConfig } from '@wrongstack/contracts/types';
import type { Agent } from '@wrongstack/core/agent';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { applyEmbeddedModelSwitch } from './embedded-host-adapters.js';
import type { EmbeddedMessageRouterDeps } from './embedded-message-router-types.js';
import { emitFallbackChoice } from './fallback-choice.js';
import { handleFallbackSuggest } from './fallback-suggest-handler.js';
import { createModelOperations } from './model-operations.js';
import { createProviderOperations } from './provider-handlers.js';
import type { ProviderRouteHandlers } from './provider-routes.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';

export function createEmbeddedProviderRoutes(
  deps: EmbeddedMessageRouterDeps,
  sessionContextOf: (sessionId?: string) => Agent['ctx'],
  isRunActive: (sessionId?: string) => boolean,
) {
  const { opts, send } = deps;

  const providerOperations = createProviderOperations({
    providerStore: deps.providerCtx.providerStore,
    broadcast: deps.providerCtx.broadcast,
    send: deps.providerCtx.send,
    modelsRegistry: deps.providerCtx.modelsRegistry,
    getDisabledModels: deps.providerCtx.getDisabledModels,
    getDisabledProviders: deps.providerCtx.getDisabledProviders,
    hostProviders: deps.providerCtx.hostProviders,
    providerAuthRegistry: deps.providerCtx.providerAuthRegistry,
    log: deps.providerCtx.log,
    hasActiveModel: () => Boolean(deps.agentConfigCtx.agent.ctx.model),
    applyModelSwitch: (providerId, modelId) =>
      applyEmbeddedModelSwitch(deps.agentConfigCtx, providerId, modelId),
  });

  const modelOperations = createModelOperations({
    context: deps.agentConfigCtx.agent.ctx,
    memoryStore: deps.agentConfigCtx.memoryStore,
    modelsRegistry: deps.agentConfigCtx.modelsRegistry,
    getConfig: () => deps.agentConfigCtx.getConfig?.(),
    getLiveProviderId: () => deps.agentConfigCtx.agent.ctx.provider.id,
    buildProvider: async (providerId) => {
      const saved = await deps.agentConfigCtx.loadSavedProviders();
      const providerCfg = saved[providerId] ?? { type: providerId };
      // WrongProxy / WrongTrace: rewrite the built provider's base URL through
      // the shared helper so the WebUI-linked helper honors the proxy toggle.
      return makeProviderFromConfig(
        providerId,
        routeProviderCfgThroughProxy(
          providerCfg,
          deps.agentConfigCtx.getConfig?.()?.baseUrl,
          providerId,
        ) as ProviderConfig,
      );
    },
    // The switch applies to the TAB that asked. Dropping the third argument
    // sent every tab's model change to the leader.
    applyModelSwitch: (providerId, modelId, sessionId) =>
      applyEmbeddedModelSwitch(
        deps.agentConfigCtx,
        providerId,
        modelId,
        sessionContextOf(sessionId),
      ),
    // Report the switch against the TAB that asked, so a "switched from X"
    // toast in tab 2 never quotes tab 3's model.
    getSessionContext: (sessionId?: string) => sessionContextOf(sessionId),
    isRunActive,
    send: deps.agentConfigCtx.send,
    broadcast: deps.providerCtx.broadcast,
    log: deps.agentConfigCtx.log,
  });

  const provider: ProviderRouteHandlers = {
    listProviders: (ws) => providerOperations.handleProvidersList(ws),
    listSavedProviders: (ws) => providerOperations.handleProvidersSaved(ws),
    listProviderModels: (ws, msg) =>
      providerOperations.handleProviderModels(
        ws,
        (msg.payload as { providerId: string }).providerId,
        {
          includeDisabled:
            (msg.payload as { includeDisabled?: boolean | undefined }).includeDisabled === true,
        },
      ),
    searchProviderModels: (ws, query, limit) =>
      providerOperations.handleProviderModelsSearch(ws, query, limit),
    switchModel: (ws, msg) => modelOperations.switchModel(ws, msg.payload),
    refineModel: (ws, msg) => modelOperations.refineModel(ws, msg.payload as never),
    fallbackChoice: async (ws, msg) => {
      const result = emitFallbackChoice(deps.sessionCtx.opts.events, msg);
      if (!result.ok) {
        send(ws, {
          type: 'error',
          payload: { phase: 'invalid_request', message: result.message },
        });
      }
    },
    suggestFallbacks: (ws, msg) =>
      handleFallbackSuggest(ws, msg.payload, {
        collectCandidates: providerOperations.collectFallbackCandidates,
        resolveLlm: (sessionId) => {
          const ctx = sessionContextOf(sessionId);
          return { provider: ctx.provider, model: ctx.model };
        },
        send,
      }),
    adoptDefaultProviderIfUnset: providerOperations.adoptDefaultProviderIfUnset,
    providerHandlers: providerOperations,
    statusTracker: deps.statusTracker,
    // Derived from the host profile path — no new dep threading needed.
    providerAuditFile: opts.profileConfigPath
      ? path.join(path.dirname(opts.profileConfigPath), 'provider-status-audit.jsonl')
      : undefined,
  };
  return provider;
}
