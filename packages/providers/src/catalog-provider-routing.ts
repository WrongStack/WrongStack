import type {
  ModelsDevModel,
  Provider,
  ProviderConfig,
  ResolvedProvider,
} from '@wrongstack/contracts/types';
import { ConfigError } from '@wrongstack/contracts/types';
import { CatalogRoutedProvider, type CatalogWireNpm, isCatalogWireNpm } from './catalog-routed.js';
import type { CompatibilityQuirks } from './compatibility-quirks.js';
import { endpointCredentialsSuppressed } from './endpoint-credentials.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { isMiniMaxProviderId } from './minimax.js';
import { createNativeCatalogProvider, isNativeCatalogNpm } from './native-catalog.js';

interface CatalogProviderRoutingOptions {
  provider: ResolvedProvider;
  /** The user-visible provider id (the config key); defaults to the catalog id. */
  instanceId?: string | undefined;
  /** The factory whose behavior applies; defaults to the catalog id. */
  definitionId?: string | undefined;
  config: ProviderConfig;
  explicitApiKey?: string | undefined;
  quirks?: CompatibilityQuirks | undefined;
}

/** Return a model-aware provider when the catalog requires one. */
export function createCatalogAwareProvider(
  options: CatalogProviderRoutingOptions,
): Provider | undefined {
  const { provider, config, explicitApiKey, quirks } = options;
  const id = options.instanceId ?? provider.id;
  const models = mergeCatalogModels(provider.models, config.customModels);
  const usesCatalogFamily = config.family === undefined || config.family === provider.family;
  if (!usesCatalogFamily) return undefined;

  if (isNativeCatalogNpm(provider.npm)) {
    // The native SDKs fall back to their own env vars and credential chains
    // (AWS keys, Google ADC, AZURE_API_KEY…) when handed no key, so for a
    // repointed endpoint "don't look the key up" is not enough — refuse to
    // build instead (WS-2026-09-26-01).
    if (!explicitApiKey && endpointCredentialsSuppressed(config)) {
      throw new ConfigError({
        message: `Provider "${id}" points at a base URL that no environment credential is sent to. Set its own key (provider_key_set or \`wstack auth ${id}\`).`,
        code: 'CONFIG_INVALID',
      });
    }
    const apiKey = explicitApiKey ?? resolveNativeCatalogKey(provider.id, provider.npm);
    if ((provider.npm === '@ai-sdk/azure' || provider.npm === '@ai-sdk/cohere') && !apiKey) {
      throw new ConfigError({
        message: `Provider "${provider.id}" requires an API key.`,
        code: 'CONFIG_INVALID',
      });
    }
    return createNativeCatalogProvider({
      id,
      catalogId: provider.id,
      npm: provider.npm,
      models,
      capabilities: capabilitiesForFamily(provider.family, { reasoning: true, tools: true }),
      apiKey,
      baseUrl: config.baseUrl,
      headers: config.headers,
      cloud: config.cloud,
    });
  }

  if (
    provider.id === 'opencode' ||
    provider.id === 'opencode-go' ||
    isMiniMaxProviderId(provider.id) ||
    !hasMixedCatalogRoutes(provider.npm, models)
  ) {
    return undefined;
  }

  const apiKey = explicitApiKey ?? readFirstEnvironment(config.envVars ?? provider.envVars);
  if (!apiKey) {
    throw new ConfigError({
      message: `Provider "${provider.id}" requires an API key.`,
      code: 'CONFIG_INVALID',
    });
  }
  return new CatalogRoutedProvider({
    id,
    definitionId: options.definitionId ?? provider.id,
    apiKey,
    defaultNpm: provider.npm as CatalogWireNpm,
    baseUrl: provider.apiBase,
    baseUrlOverride: sameEndpoint(config.baseUrl, provider.apiBase) ? undefined : config.baseUrl,
    headers: config.headers,
    models,
    quirks,
  });
}

function resolveNativeCatalogKey(providerId: string, npm: string): string | undefined {
  if (npm === '@ai-sdk/cohere') return process.env['COHERE_API_KEY'];
  if (npm === '@ai-sdk/amazon-bedrock') return process.env['AWS_BEARER_TOKEN_BEDROCK'];
  if (npm === '@ai-sdk/google-vertex') return process.env['GOOGLE_VERTEX_API_KEY'];
  if (npm === 'ai-gateway-provider') return process.env['CLOUDFLARE_API_TOKEN'];
  if (npm === '@ai-sdk/azure') {
    return providerId === 'azure-cognitive-services'
      ? process.env['AZURE_COGNITIVE_SERVICES_API_KEY']
      : process.env['AZURE_API_KEY'];
  }
  return undefined;
}

function hasMixedCatalogRoutes(
  providerNpm: string | undefined,
  models: readonly ModelsDevModel[],
): boolean {
  if (!isCatalogWireNpm(providerNpm)) return false;
  return models.some((model) => {
    const modelNpm = model.provider?.npm?.toLowerCase();
    return isCatalogWireNpm(modelNpm) && modelNpm !== providerNpm;
  });
}

function mergeCatalogModels(
  models: readonly ModelsDevModel[],
  customModels: ProviderConfig['customModels'],
): ModelsDevModel[] {
  if (!customModels) return [...models];
  const merged = new Map(models.map((model) => [model.id, model]));
  for (const [id, definition] of Object.entries(customModels)) {
    const modelsDev = definition.modelsDev;
    if (!modelsDev) continue;
    const current = merged.get(id);
    const customName = modelsDev['name'];
    merged.set(id, {
      ...(current ?? { id, name: id }),
      ...modelsDev,
      id,
      name: typeof customName === 'string' ? customName : (current?.name ?? id),
    });
  }
  return [...merged.values()];
}

function sameEndpoint(left: string | undefined, right: string | undefined): boolean {
  if (left === undefined) return true;
  if (right === undefined) return false;
  return (
    left.trim().replace(/\/+$/, '').toLowerCase() === right.trim().replace(/\/+$/, '').toLowerCase()
  );
}

function readFirstEnvironment(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}
