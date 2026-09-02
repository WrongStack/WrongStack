/**
 * First-run setup + active-provider resolution.
 *
 * Phase 1b of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined the provider-resolution
 * ladder (configured provider → first saved provider → stub provider +
 * `needsSetup` flag). This module lifts that ladder into a single pure-ish
 * function so `index.ts` reads as orchestration, not branching.
 *
 * No behaviour change: the three branches, the structured error logs, the
 * `needsSetup` flag, and the stub provider's exact shape are preserved
 * verbatim. The function throws on the same failures the inline code did.
 */
import type { ProviderRegistry } from '@wrongstack/core/registry';
import type { Provider, ProviderConfig } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { Config } from '@wrongstack/core/types';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import { makeProviderFromConfig } from '@wrongstack/providers';

const UNCONFIGURED_CAPABILITIES: Provider['capabilities'] = {
  tools: false,
  parallelTools: false,
  vision: false,
  streaming: false,
  promptCache: false,
  systemPrompt: false,
  jsonMode: false,
  reasoning: false,
  maxContext: 0,
  cacheControl: 'none',
  topK: false,
  frequencyPenalty: false,
  presencePenalty: false,
  seed: false,
  structuredOutput: false,
  logprobs: false,
  audio: false,
  multipleCompletions: false,
};

function makeUnconfiguredProvider(): Provider {
  const message = 'No provider configured. Complete setup before starting an agent run.';
  return {
    id: 'unconfigured',
    capabilities: UNCONFIGURED_CAPABILITIES,
    // biome-ignore lint/correctness/useYield: Provider.stream must be an async generator; this unconfigured stub always throws before it can yield.
    async *stream() {
      throw new Error(message);
    },
    async complete() {
      throw new Error(message);
    },
  };
}

interface ResolveSetupProviderOptions {
  config: Config;
  /** True when neither provider nor model is set in config. */
  needsProvider: boolean;
  providerRegistry: ProviderRegistry;
}

interface ResolvedSetupProvider {
  provider: Provider;
  /**
   * True when no provider could be resolved and a stub was created — the
   * frontend should show the onboarding/setup screen. False otherwise.
   * (The caller merges this into its existing `needsSetup` flag.)
   */
  needsSetup: boolean;
}

function logCreateFailure(event: string, err: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event,
      message: toErrorMessage(err),
      timestamp: new Date().toISOString(),
    }),
  );
}

/**
 * Resolve the active provider from config, mirroring the inline ladder that
 * used to live in `startWebUI`:
 *
 *   1. provider + model configured → build from the configured provider.
 *   2. no active provider but saved providers exist → build from the first
 *      saved provider (vault already decrypted its key).
 *   3. no providers at all → boot with an inert placeholder provider and signal
 *      `needsSetup` so the frontend shows the onboarding screen.
 *
 * Throws on provider-construction failure (same as the inline code).
 */
export function resolveSetupProvider(opts: ResolveSetupProviderOptions): ResolvedSetupProvider {
  const { config, needsProvider, providerRegistry } = opts;

  // Branch 1 — configured provider.
  if (!needsProvider) {
    const providerConfig: ProviderConfig | Record<string, unknown> = config.providers?.[
      config.provider
    ] ?? {
      type: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
    };
    try {
      // WrongProxy / WrongTrace: rewrite THIS provider's base URL through the
      // shared helper when the toggle is on and the daemon is reachable.
      // The standalone WebUI seeds the singleton at boot (proxy-runtime.ts);
      // without this step the initial provider carries the raw base URL and
      // the separate WebUI process bypasses the proxy entirely.
      const routedConfig = routeProviderCfgThroughProxy(
        providerConfig,
        config.baseUrl,
        config.provider,
      );
      const cfgWithType = { ...routedConfig, type: config.provider };
      const provider: Provider =
        config.features.modelsRegistry && providerRegistry.has(config.provider)
          ? providerRegistry.create(cfgWithType)
          : makeProviderFromConfig(config.provider, cfgWithType);
      return { provider, needsSetup: false };
    } catch (err) {
      logCreateFailure('webui.provider_create_failed', err);
      throw err;
    }
  }

  // Branch 2 — fall back to the first saved provider (usable encrypted key).
  const savedProviders = config.providers ?? {};
  const firstKey = Object.keys(savedProviders)[0];
  if (firstKey) {
    const firstProvider = expectDefined(savedProviders[firstKey]);
    try {
      // WrongProxy / WrongTrace: rewrite the fallback provider's base URL
      // through the shared helper, same as Branch 1.
      const routedConfig = routeProviderCfgThroughProxy(firstProvider, config.baseUrl, firstKey);
      const provider = makeProviderFromConfig(firstKey, {
        ...routedConfig,
        type: firstKey,
        family: firstProvider.family,
        apiKey: firstProvider.apiKey,
      });
      console.log('[WebUI] Using saved provider:', firstKey);
      return { provider, needsSetup: false };
    } catch (err) {
      logCreateFailure('webui.provider_stub_create_failed', err);
      throw err;
    }
  }

  // Branch 3 — no providers at all. Boot with an inert placeholder so
  // the server initializes without smuggling in a real provider/model
  // identity; the frontend shows setup until the user picks one.
  console.log('[WebUI] No providers configured — showing setup screen');
  const provider = makeUnconfiguredProvider();
  return { provider, needsSetup: true };
}
