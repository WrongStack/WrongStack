import type { Config } from '@wrongstack/contracts/types/config';
import type { CouncilQuestion, CouncilResult } from '@wrongstack/contracts/types/council';
import type { Logger } from '@wrongstack/contracts/types/logger';
import type { OneShotLLMInput, OneShotLLMResult } from '@wrongstack/contracts/types/one-shot-llm';
import type {
  MetricsSinkView,
  PluginCouncilOptions,
  PluginLLM,
  PluginLLMOptions,
  PluginLLMResult,
} from '@wrongstack/contracts/types/plugin';
import type { Provider, Request } from '@wrongstack/contracts/types/provider';
import { callWithDeadline } from '../execution/llm-call-deadline.js';
import type { ProviderRegistry } from '../registry/provider-registry.js';

/**
 * Build the `api.llm` facade for one plugin.
 *
 * Resolution order for provider/model on every call:
 *   1. per-call `PluginLLMOptions.provider` / `.model`
 *   2. per-plugin config: `config.extensions[<owner>].llm.{provider,model}`
 *   3. host defaults (`init.llm.provider` / `init.llm.model`)
 *
 * Providers other than the host default are created lazily via the
 * host-supplied `createProvider` (preferred — it knows about saved
 * provider configs and non-catalog wire families) or, as a fallback,
 * `providerRegistry.create({ ...config.providers[name], type: name })`.
 * Created instances are cached per `(name, model)` for the lifetime of
 * the API object.
 */
export function makePluginLLM(
  owner: string,
  hostLLM: {
    provider: Provider;
    model: string;
    getProvider?: (() => Provider) | undefined;
    getModel?: (() => string) | undefined;
    createProvider?: ((name: string, model?: string) => Provider) | undefined;
    oneShot?: ((input: OneShotLLMInput) => Promise<OneShotLLMResult>) | undefined;
    council?: ((question: CouncilQuestion) => Promise<CouncilResult>) | undefined;
  },
  providerRegistry: ProviderRegistry,
  config: Config,
  getLiveConfig: () => Config | undefined,
  metrics: MetricsSinkView,
  log: Logger,
): PluginLLM {
  const providerCache = new Map<string, Provider>();
  const PROVIDER_CACHE_MAX = 32;
  let providerCacheConfigRef: Config | undefined = config;
  const currentConfig = (): Config => getLiveConfig() ?? config;
  const currentProvider = (): Provider => hostLLM.getProvider?.() ?? hostLLM.provider;
  const currentModel = (): string => hostLLM.getModel?.() ?? hostLLM.model;
  // No invented output cap: a plugin's call is bounded by the model's own
  // output ceiling unless the plugin or the user's extension config asks for
  // less. A fixed default starved reasoning models into empty replies.
  const DEFAULT_TIMEOUT_MS = 30_000;
  const HARD_TIMEOUT_MS = 120_000;

  const pluginDefaults = (): {
    provider?: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    role?: string;
    fallbackModels?: string[];
    timeoutMs?: number;
    councilProfile?: string;
  } => {
    // Once a ConfigStore update has been observed, the live extensions
    // map REPLACES the setup-time snapshot — so a cleared override falls
    // back to the session default instead of resurrecting the old value.
    const extensions = currentConfig().extensions;
    const raw = extensions?.[owner]?.['llm'];
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    return {
      ...(typeof r['provider'] === 'string' && r['provider'] ? { provider: r['provider'] } : {}),
      ...(typeof r['model'] === 'string' && r['model'] ? { model: r['model'] } : {}),
      ...(typeof r['maxTokens'] === 'number' ? { maxTokens: r['maxTokens'] } : {}),
      ...(typeof r['temperature'] === 'number' ? { temperature: r['temperature'] } : {}),
      ...(typeof r['role'] === 'string' && r['role'] ? { role: r['role'] } : {}),
      ...(Array.isArray(r['fallbackModels']) &&
      r['fallbackModels'].every((v) => typeof v === 'string')
        ? { fallbackModels: [...r['fallbackModels']] as string[] }
        : {}),
      ...(typeof r['timeoutMs'] === 'number' ? { timeoutMs: r['timeoutMs'] } : {}),
      ...(typeof r['councilProfile'] === 'string' && r['councilProfile']
        ? { councilProfile: r['councilProfile'] }
        : {}),
    };
  };

  const resolveProvider = (
    name: string | undefined,
    model: string,
  ): { provider: Provider; providerName: string } => {
    const defaults = pluginDefaults();
    const liveProvider = currentProvider();
    const liveConfig = currentConfig();
    if (liveConfig !== providerCacheConfigRef) {
      providerCache.clear();
      providerCacheConfigRef = liveConfig;
    }
    const providerName = name ?? defaults.provider ?? liveProvider.id;
    // The host session's own provider serves the default name directly —
    // no re-creation, and per-model capabilities stay as the host resolved them.
    if (providerName === liveProvider.id) {
      return { provider: liveProvider, providerName };
    }
    const cacheKey = `${providerName}|${model}`;
    const cached = providerCache.get(cacheKey);
    if (cached) return { provider: cached, providerName };
    let created: Provider;
    if (hostLLM.createProvider) {
      created = hostLLM.createProvider(providerName, model);
    } else {
      const savedCfg = liveConfig.providers?.[providerName];
      const factoryType = savedCfg?.type ?? providerName;
      created = providerRegistry.create(
        { ...(savedCfg ?? {}), type: providerName, model },
        factoryType,
      );
    }
    while (providerCache.size >= PROVIDER_CACHE_MAX) {
      const oldest = providerCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      providerCache.delete(oldest);
    }
    providerCache.set(cacheKey, created);
    return { provider: created, providerName };
  };

  const pluginLlm: PluginLLM = {
    defaults() {
      const d = pluginDefaults();
      return {
        provider: d.provider ?? currentProvider().id,
        model: d.model ?? currentModel(),
      };
    },
    async complete(prompt: string, opts?: PluginLLMOptions): Promise<PluginLLMResult> {
      const defaults = pluginDefaults();
      const model = opts?.model ?? defaults.model ?? currentModel();
      const providerName = opts?.provider ?? defaults.provider ?? currentProvider().id;
      const maxTokens = opts?.maxTokens ?? defaults.maxTokens;
      const temperature = opts?.temperature ?? defaults.temperature;
      const timeoutMs = Math.min(
        HARD_TIMEOUT_MS,
        Math.max(1, opts?.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      );

      if (hostLLM.oneShot) {
        metrics.counter('llm.calls', 1, { provider: providerName, model, engine: 'one-shot' });
        const result = await callWithDeadline(
          (signal) =>
            hostLLM.oneShot!({
              userPrompt: prompt,
              providerId: providerName,
              model,
              ...(maxTokens !== undefined ? { maxTokens } : {}),
              timeoutMs,
              ...(temperature !== undefined ? { temperature } : {}),
              ...(opts?.system ? { system: opts.system } : {}),
              ...(opts?.responseFormat === 'json'
                ? { responseFormat: { type: 'json_object' as const } }
                : {}),
              signal,
              ...((opts?.role ?? defaults.role) ? { role: opts?.role ?? defaults.role } : {}),
              ...((opts?.fallbackModels ?? defaults.fallbackModels)
                ? { fallbackModels: [...(opts?.fallbackModels ?? defaults.fallbackModels ?? [])] }
                : {}),
            }),
          opts?.signal,
          timeoutMs,
          `Plugin "${owner}" One Shot request timed out`,
        );
        if (result.error) {
          metrics.counter('llm.errors', 1, { provider: result.provider, model: result.model });
          throw new Error(result.error);
        }
        metrics.counter('llm.tokens_in', result.tokens.input);
        metrics.counter('llm.tokens_out', result.tokens.output);
        return {
          text: result.text,
          model: result.model,
          provider: result.provider,
          usage: { input: result.tokens.input, output: result.tokens.output },
          stopReason: result.stopReason ?? 'end_turn',
          fromFallback: result.fromFallback,
          attempts: result.attempts,
          durationMs: result.durationMs,
        };
      }

      // Compatibility path for minimal hosts and focused unit tests that wire
      // only a Provider. The CLI always supplies the One Shot runtime above.
      const { provider } = resolveProvider(providerName, model);
      const request: Request = {
        model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(opts?.system ? { system: [{ type: 'text', text: opts.system }] } : {}),
        ...(opts?.responseFormat === 'json'
          ? { responseFormat: { type: 'json_object' as const } }
          : {}),
      };
      metrics.counter('llm.calls', 1, { provider: providerName, model });
      try {
        const response = await callWithDeadline(
          (signal) => provider.complete(request, { signal }),
          opts?.signal,
          timeoutMs,
          `Plugin "${owner}" LLM request timed out`,
        );
        const text = response.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('');
        metrics.counter('llm.tokens_in', response.usage.input);
        metrics.counter('llm.tokens_out', response.usage.output);
        return {
          text,
          model: response.model,
          provider: providerName,
          usage: { input: response.usage.input, output: response.usage.output },
          stopReason: response.stopReason,
        };
      } catch (err) {
        metrics.counter('llm.errors', 1, { provider: providerName, model });
        log.warn(`plugin "${owner}" llm.complete failed`, {
          provider: providerName,
          model,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };

  const council = hostLLM.council;
  if (council) {
    pluginLlm.council = async (
      question: string,
      opts?: PluginCouncilOptions,
    ): Promise<CouncilResult> => {
      const trimmed = question.trim();
      if (!trimmed) throw new Error('Plugin Council question must not be empty.');
      if (trimmed.length > 20_000) {
        throw new Error('Plugin Council question must not exceed 20000 characters.');
      }
      if ((opts?.context?.length ?? 0) > 80_000) {
        throw new Error('Plugin Council context must not exceed 80000 characters.');
      }
      const defaults = pluginDefaults();
      const timeoutMs = Math.min(
        HARD_TIMEOUT_MS,
        Math.max(1, opts?.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      );
      metrics.counter('llm.council.calls', 1, { plugin: owner });
      const result = await callWithDeadline(
        (signal) =>
          council({
            question: trimmed,
            ...(opts?.context ? { context: opts.context } : {}),
            ...(opts?.options ? { options: opts.options } : {}),
            ...((opts?.profile ?? defaults.councilProfile)
              ? { profile: opts?.profile ?? defaults.councilProfile }
              : {}),
            signal,
          }),
        opts?.signal,
        timeoutMs,
        `Plugin "${owner}" Council request timed out`,
      );
      metrics.counter('llm.tokens_in', result.usage.inputTokens);
      metrics.counter('llm.tokens_out', result.usage.outputTokens);
      if (result.status === 'failed') metrics.counter('llm.errors', 1, { provider: 'council' });
      return result;
    };
  }

  return pluginLlm;
}
