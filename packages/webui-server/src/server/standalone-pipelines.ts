/**
 * The standalone server's agent pipelines.
 *
 * The CLI host builds them in `setupPipelines`; the standalone server built
 * them bare. With no error boundary a plugin middleware's crash failed the
 * whole turn, and with no model-runtime middleware the reasoning mode/effort,
 * cache TTL and generic parameters a user set here were saved and never
 * reached a request.
 *
 * Its tabs can run different models, so the reasoning profile is looked up
 * per request from the provider and model the request goes to, not from the
 * process's boot model.
 */

import type { EventBus, Middleware } from '@wrongstack/contracts/kernel';
import type { Config, ModelsRegistry, Provider, Request } from '@wrongstack/contracts/types';
import {
  type AgentPipelines,
  createDefaultPipelines,
  installPipelineErrorBoundaries,
} from '@wrongstack/core/agent';
import { createModelRuntimeMiddleware } from '@wrongstack/core/execution';
import { resolveProviderModelMetadata } from './model-catalog.js';

interface StandalonePipelineDeps {
  getConfig: () => Config;
  /** The process's current provider, for a request built without one bound. */
  getProvider: () => Provider;
  modelsRegistry: ModelsRegistry;
  events: EventBus;
  logger: { warn(msg: string): void; error(msg: string, err?: unknown): void };
}

export function createStandaloneAgentPipelines(deps: StandalonePipelineDeps): AgentPipelines {
  const pipelines = createDefaultPipelines();
  installPipelineErrorBoundaries(pipelines, deps);
  pipelines.request.use(createStandaloneModelRuntimeMiddleware(deps));
  return pipelines;
}

export function createStandaloneModelRuntimeMiddleware(deps: {
  getConfig: () => Config;
  /** The process's current provider, for a request built without one bound. */
  getProvider: () => Provider;
  modelsRegistry: ModelsRegistry;
  logger: { warn(msg: string): void };
}): Middleware<Request> {
  const warned = new Set<string>();
  return createModelRuntimeMiddleware({
    getSettings: () => deps.getConfig().modelRuntime,
    getReasoningConfig: () => undefined,
    resolveReasoningConfig: async (req, bound) => {
      const provider = bound ?? deps.getProvider();
      const model = await resolveProviderModelMetadata(
        deps.modelsRegistry,
        provider.id,
        req.model,
        deps.getConfig().providers?.[provider.id],
      ).catch(() => undefined);
      return model?.capabilities.reasoningConfig;
    },
    getCapabilities: () => deps.getProvider().capabilities,
    onWarning: (message) => {
      if (warned.has(message)) return;
      warned.add(message);
      deps.logger.warn(`model-runtime: ${message}`);
    },
  });
}

/**
 * Project the reasoning / cache controls of a `prefs.update` payload onto a
 * `Config.modelRuntime` value. Returns undefined when the payload touches
 * none of them. The one projection behind both the persisted config and the
 * live copy the middleware above reads.
 */
export function projectModelRuntimePrefs(
  current: unknown,
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const touched =
    typeof payload['reasoningMode'] === 'string' ||
    typeof payload['reasoningEffort'] === 'string' ||
    typeof payload['reasoningPreserve'] === 'boolean' ||
    typeof payload['cacheTtl'] === 'string';
  if (!touched) return undefined;
  const mr: Record<string, unknown> = { ...((current as Record<string, unknown>) ?? {}) };
  const reasoning: Record<string, unknown> = {
    ...((mr['reasoning'] as Record<string, unknown>) ?? {}),
  };
  if (typeof payload['reasoningMode'] === 'string') reasoning['mode'] = payload['reasoningMode'];
  // 'auto' = "follow the general setting" sentinel: valid as this tab's
  // session-scoped pref, but it must never become the persisted global
  // effort or it would reach the wire as a literal level on models with
  // an undocumented vocabulary.
  if (typeof payload['reasoningEffort'] === 'string' && payload['reasoningEffort'] !== 'auto')
    reasoning['effort'] = payload['reasoningEffort'];
  if (typeof payload['reasoningPreserve'] === 'boolean')
    reasoning['preserve'] = payload['reasoningPreserve'];
  mr['reasoning'] = reasoning;
  if (typeof payload['cacheTtl'] === 'string' && payload['cacheTtl'] !== 'default') {
    mr['cache'] = { ttl: payload['cacheTtl'] };
  } else if (payload['cacheTtl'] === 'default') {
    delete mr['cache'];
  }
  return mr;
}
