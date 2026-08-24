import type { Config, Provider, ReasoningConfig, SubagentConfig } from '@wrongstack/core/types';
import { makeProviderFromConfig, withCatalogCapabilities } from '@wrongstack/providers';
import { refreshRuntimeModelCatalog, resolveRuntimeMaxContext } from '../context-limit.js';
import type { MultiAgentDeps } from './host-types.js';
import {
  getProxyConfig,
  rewriteBaseUrl,
  shouldRewriteFor,
} from '@wrongstack/core/wiring/proxy-rewrite';

export async function buildHostSubagentProvider(
  deps: MultiAgentDeps,
  config: Config,
  overrideId?: string | undefined,
  model?: string | undefined,
): Promise<Provider> {
  const requestedProviderId = overrideId ?? config.provider;
  const providerId =
    requestedProviderId === config.provider ||
    config.providers?.[requestedProviderId] !== undefined ||
    deps.providerRegistry.has(requestedProviderId)
      ? requestedProviderId
      : config.provider;
  const newCfg = config.providers?.[providerId] ?? {
    type: providerId,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
  };
  // WrongProxy / WrongTrace: rewrite THIS subagent's base URL through the
  // shared singleton when the toggle is on and the daemon is reachable.
  // Subagents must traverse the same proxy as the leader — a bare
  // `providerRegistry.create(cfgWithType)` here would bypass the reroute
  // entirely, so fan-out/fallback workers talk to the upstream directly
  // even though the leader goes through the proxy. This mirrors
  // `buildProvider` in `light-subagent-factory.ts` and `resolveProviderCfg`
  // in `provider-runtime.ts`.
  const factoryType = newCfg.type ?? providerId;
  const rawBaseUrl = newCfg.baseUrl ?? config.baseUrl;
  const baseUrl =
    rawBaseUrl && shouldRewriteFor(factoryType)
      ? rewriteBaseUrl(rawBaseUrl, getProxyConfig().url)
      : rawBaseUrl;
  const cfgWithType = {
    ...newCfg,
    type: providerId,
    ...(baseUrl !== newCfg.baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
  };
  let provider = deps.providerRegistry.has(providerId)
    ? deps.providerRegistry.create(cfgWithType)
    : makeProviderFromConfig(providerId, cfgWithType);
  if (deps.modelsRegistry) {
    const resolvedModel = model ?? config.model;
    // Subagents routinely run a different model than the leader (model
    // matrix, role pins). Overlay THIS model's catalog facts — otherwise the
    // provider carries only the wire-family baseline, where `maxOutput` is
    // undefined and every response gets capped at the adapter's last-resort
    // 8192 regardless of what the model actually supports.
    provider = await withCatalogCapabilities(deps.modelsRegistry, providerId, provider, {
      ...cfgWithType,
      model: resolvedModel,
    });
    await refreshRuntimeModelCatalog({
      modelsRegistry: deps.modelsRegistry,
      reason: `${providerId}/${resolvedModel}`,
    });
    const mc = await resolveRuntimeMaxContext({
      modelsRegistry: deps.modelsRegistry,
      config,
      provider,
      runtimeProviderConfig: cfgWithType,
      providerId,
      modelId: resolvedModel,
    });
    if (mc && mc > 0) provider.capabilities.maxContext = mc;
  }
  return provider;
}

export async function resolveHostSubagentReasoningConfig(
  deps: MultiAgentDeps,
  providerId: string,
  modelId: string,
): Promise<ReasoningConfig | undefined> {
  if (!deps.modelsRegistry) return undefined;
  try {
    return (await deps.modelsRegistry.getModel(providerId, modelId))?.capabilities.reasoningConfig;
  } catch {
    return undefined;
  }
}

export interface HostSubagentModelSelection {
  effProvider: string;
  effModel: string;
  fallbackProfile: string | undefined;
  runtimeOverride: SubagentConfig['modelRuntime'] | undefined;
  closedModelPolicy: boolean;
  startupTargets: Array<{ provider: string; model: string }>;
}

export function resolveHostSubagentModelSelection(
  liveConfig: Config,
  effectiveCfg: SubagentConfig,
  matrixTarget:
    | {
        provider?: string | undefined;
        model?: string | undefined;
        fallbackProfile?: string | undefined;
        modelRuntime?: SubagentConfig['modelRuntime'] | undefined;
      }
    | undefined,
): HostSubagentModelSelection {
  let effProvider = effectiveCfg.provider ?? matrixTarget?.provider ?? liveConfig.provider;
  let effModel = effectiveCfg.model ?? matrixTarget?.model ?? liveConfig.model;
  const modelPolicy = effectiveCfg.modelPolicy;
  const closedModelPolicy = modelPolicy?.strict === true;
  const allowedModels = modelPolicy?.allowed ?? [];
  if (
    modelPolicy &&
    !allowedModels.some((target) => target.provider === effProvider && target.model === effModel)
  ) {
    const firstAllowed = allowedModels[0];
    if (!firstAllowed) throw new Error(`Agent "${effectiveCfg.role}" has no allowed models.`);
    effProvider = firstAllowed.provider;
    effModel = firstAllowed.model;
  }
  const fallbackProfile = modelPolicy
    ? undefined
    : (effectiveCfg.fallbackProfile ?? matrixTarget?.fallbackProfile);
  const runtimeOverride = effectiveCfg.modelRuntime ?? matrixTarget?.modelRuntime;
  const startupTargets = modelPolicy
    ? [
        { provider: effProvider, model: effModel },
        ...(modelPolicy.fallbacks ?? []),
        ...(closedModelPolicy ||
        (effProvider === liveConfig.provider && effModel === liveConfig.model)
          ? []
          : [{ provider: liveConfig.provider, model: liveConfig.model }]),
      ]
    : [
        { provider: effProvider, model: effModel },
        ...(effProvider === liveConfig.provider && effModel === liveConfig.model
          ? []
          : [{ provider: liveConfig.provider, model: liveConfig.model }]),
      ];

  return {
    effProvider,
    effModel,
    fallbackProfile,
    runtimeOverride,
    closedModelPolicy,
    startupTargets,
  };
}
