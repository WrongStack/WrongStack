import { ProviderRegistry } from '@wrongstack/core/registry';
import type { ResolvedProvider } from '@wrongstack/core/types';
import { type Config, ConfigError, type Logger, type ModelsRegistry } from '@wrongstack/core/types';
import {
  buildProviderFactoriesFromRegistry,
  createAiGatewayProviderFactory,
  createSetupProviderFactory,
  installCatalogModelOutputLimits,
  isSetupProvider,
  makeProviderFromConfig,
  setupProviderResolved,
  withCatalogCapabilities,
} from '@wrongstack/providers';
import {
  fallbackCodexProviderModels,
  filterCurrentCodexModelIds,
  isCodexCatalogModel,
} from '../auth-menu/openai-codex-oauth.js';
import { resolveProviderCfgWithProxy } from './provider-runtime.js';

interface ProviderSetupResult {
  resolvedProvider: ResolvedProvider | undefined;
  provider: ReturnType<ProviderRegistry['create']>;
  providerRegistry: ProviderRegistry;
}

export async function setupProvider(params: {
  config: Config;
  modelsRegistry: ModelsRegistry;
  logger: Logger;
}): Promise<ProviderSetupResult> {
  const { config, modelsRegistry, logger } = params;

  // Setup mode short-circuits catalog resolution entirely. It is never
  // published through models.dev and never written into `config.providers`,
  // so both lookups below would miss and boot would fall through to
  // makeProviderFromConfig's "needs an explicit family" error.
  if (isSetupProvider(config.provider)) {
    const providerRegistry = new ProviderRegistry();
    providerRegistry.register(createSetupProviderFactory());
    return {
      resolvedProvider: setupProviderResolved(),
      provider: providerRegistry.create({ type: config.provider }),
      providerRegistry,
    };
  }

  // Resolve provider details from models.dev.
  const savedProviderCfg = config.providers?.[config.provider];
  let resolvedProvider = await modelsRegistry.getProvider(config.provider).catch(() => undefined);
  if (!resolvedProvider && savedProviderCfg?.type && savedProviderCfg.type !== config.provider) {
    resolvedProvider = await modelsRegistry
      .getProvider(savedProviderCfg.type)
      .catch(() => undefined);
  }
  if (!resolvedProvider) {
    if (savedProviderCfg?.family) {
      // Config-only provider not in the models.dev catalog — e.g. the OAuth
      // subscription families (openai-codex, anthropic-oauth, github-copilot)
      // or any user-defined provider with an explicit `family`. Synthesize a
      // ResolvedProvider from config so boot proceeds (the actual transport is
      // still built below via makeProviderFromConfig / the registry).
      // When the saved config carries no models but the family is one of
      // the OAuth/subscription wire families, seed with the canonical
      // model list so the provider shows up in pickers and the WebUI.
      const family = savedProviderCfg.family;
      const savedModels = savedProviderCfg.models;
      let models: Array<{ id: string; name: string }>;
      if (savedModels && savedModels.length > 0) {
        models = savedModels.map((m) => ({ id: m, name: m }));
      } else if (family === 'openai-codex') {
        // Resolve from the models.dev catalog: pick all models with
        // family=gpt-codex* under the `openai` provider. When the
        // catalog is unavailable, fall back to the documented defaults.
        const openaiProvider = await modelsRegistry.getProvider('openai').catch(() => undefined);
        if (openaiProvider) {
          const catalogById = new Map(
            openaiProvider.models
              .filter(isCodexCatalogModel)
              .map((m) => [m.id, { id: m.id, name: m.name }] as const),
          );
          const catalogModels = filterCurrentCodexModelIds(catalogById.keys())
            .map((id) => catalogById.get(id))
            .filter((m): m is { id: string; name: string } => Boolean(m));
          if (catalogModels.length > 0) {
            models = catalogModels;
          } else {
            models = fallbackCodexProviderModels();
          }
        } else {
          models = fallbackCodexProviderModels();
        }
      } else {
        models = [];
      }

      resolvedProvider = {
        id: config.provider,
        name: config.provider,
        family,
        apiBase: savedProviderCfg.baseUrl,
        envVars: savedProviderCfg.envVars ?? [],
        models,
        npm: undefined,
      };
    } else {
      logger.warn(
        `Provider "${config.provider}" not found in models.dev. Continuing with raw config.`,
      );
    }
  } else if (resolvedProvider.family === 'unsupported' && !savedProviderCfg?.family) {
    throw new ConfigError({
      message:
        `Provider "${config.provider}" uses an unsupported wire family (${resolvedProvider.npm}). ` +
        `Install a plugin to enable it, or pick a different provider.`,
      code: 'CONFIG_INVALID',
      context: { provider: config.provider, family: resolvedProvider.npm, kind: 'unsupported' },
    });
  }

  // Per-request output ceilings. The capability overlay below is resolved
  // ONCE, for `config.model`; this index is keyed on the model of the request
  // being built, so `/model` switches, fallback hops and subagents running a
  // model-matrix entry all get their own model's `limit.output` instead of the
  // adapters' 8192 last-resort literal.
  if (config.features.modelsRegistry) {
    await installCatalogModelOutputLimits({
      registry: modelsRegistry,
      getConfig: () => config,
      log: (message) => logger.debug(message),
    });
  }

  // Provider registry — essential built-ins exist even when the optional
  // models.dev catalog is disabled; catalog factories are layered on top.
  const providerRegistry = new ProviderRegistry();
  providerRegistry.register(createAiGatewayProviderFactory());
  // Always available, never selected implicitly: registering setup mode here
  // means a `/model wrongstack-setup` switch or a fallback hop can construct
  // it instead of throwing "provider type not registered".
  providerRegistry.register(createSetupProviderFactory());
  if (config.features.modelsRegistry) {
    try {
      const factories = await buildProviderFactoriesFromRegistry({
        registry: modelsRegistry,
        log: logger,
      });
      for (const f of factories) providerRegistry.register(f);
    } catch (err) {
      throw new ConfigError({
        message:
          `Failed to load models.dev registry: ${err instanceof Error ? err.message : err}\n` +
          `Try \`wstack models refresh\` once you have network access, or run with --no-features.`,
        code: 'CONFIG_INVALID',
        context: { phase: 'registry-build', provider: config.provider },
        cause: err,
      });
    }
  }

  // Provider instance — resolve the user-visible id separately from the
  // factory lookup key so saved aliases behave the same at boot and at
  // runtime. `resolveProviderCfgWithProxy` is the single source of truth
  // for the saved-config merge + WrongProxy rewrite; using it here
  // preserves `savedProviderCfg.type` so saved aliases like
  // `minimax-coding-plan` (with `type: 'anthropic'`) still resolve to
  // the correct factory. The previous hand-copied block lost the alias
  // type — see Chimera review on the proxy-rerouting PR.
  const { cfg: providerConfig, factoryType } = resolveProviderCfgWithProxy(
    config,
    config.provider,
    // Boot-time rewrite decision — the first "is traffic proxied?" line in
    // wrongstack.log. info-level only; skips log too (they answer WHY).
    { logger },
  );
  let provider: ReturnType<ProviderRegistry['create']>;
  try {
    const cfgWithType = { ...providerConfig, type: config.provider };
    if (providerRegistry.has(factoryType)) {
      provider = providerRegistry.create(cfgWithType, factoryType);
    } else {
      provider = makeProviderFromConfig(config.provider, { ...cfgWithType, type: factoryType });
    }
  } catch (err) {
    throw new ConfigError({
      message: `Failed to create provider: ${err instanceof Error ? err.message : err}`,
      code: 'CONFIG_INVALID',
      context: { phase: 'provider-create', provider: config.provider },
      cause: err,
    });
  }

  // Resolve per-model capabilities (maxOutput, maxContext, etc.) from the
  // models.dev catalog and overlay them on the provider's family baseline.
  // Without this step `provider.capabilities.maxOutput` stays at the
  // family default — and Chimera / other subagents would default to a
  // conservative 8K instead of the model's actual output ceiling.
  //
  // The overlay helper is exported from @wrongstack/providers so the
  // same resolution rules (customCaps → catalog → base) are shared with
  // any other caller that constructs a Provider post-init. Failures
  // inside are swallowed inside the helper — the family default stands
  // and the per-request output-limit lookup installed above still resolves
  // the ceiling from the catalog.
  if (config.features.modelsRegistry) {
    provider = await withCatalogCapabilities(
      modelsRegistry,
      config.provider,
      provider,
      { ...providerConfig, type: config.provider, model: config.model },
      logger,
    );
  }

  return { resolvedProvider, provider, providerRegistry };
}
