import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createBedrockMantle } from '@ai-sdk/amazon-bedrock/mantle';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createGoogleVertex } from '@ai-sdk/google-vertex';
import { createGoogleVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createGoogleVertexMaas } from '@ai-sdk/google-vertex/maas';
import type { Capabilities, ModelsDevModel, Provider } from '@wrongstack/core/types';
import { ConfigError } from '@wrongstack/core/types';
import type { LanguageModel } from 'ai';
import { createAiGateway as createCloudflareAiGateway } from 'ai-gateway-provider';
import { createAnthropic } from 'ai-gateway-provider/providers/anthropic';
import { createGoogleGenerativeAI } from 'ai-gateway-provider/providers/google';
import { createOpenAI } from 'ai-gateway-provider/providers/openai';
import { createUnified } from 'ai-gateway-provider/providers/unified';
import { AiGatewayProvider } from './ai-gateway.js';

export type NativeCatalogNpm =
  | '@ai-sdk/amazon-bedrock'
  | '@ai-sdk/azure'
  | '@ai-sdk/cohere'
  | '@ai-sdk/google-vertex'
  | 'ai-gateway-provider';

const NATIVE_CATALOG_NPMS = new Set<string>([
  '@ai-sdk/amazon-bedrock',
  '@ai-sdk/azure',
  '@ai-sdk/cohere',
  '@ai-sdk/google-vertex',
  'ai-gateway-provider',
]);

export function isNativeCatalogNpm(value: string | undefined): value is NativeCatalogNpm {
  return value !== undefined && NATIVE_CATALOG_NPMS.has(value);
}

export interface NativeCatalogProviderOptions {
  id: string;
  npm: NativeCatalogNpm;
  models: readonly ModelsDevModel[];
  capabilities: Capabilities;
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/** Bridge native AI SDK providers into WrongStack's canonical Provider stream. */
export function createNativeCatalogProvider(opts: NativeCatalogProviderOptions): Provider {
  const models = new Map(opts.models.map((model) => [model.id, model]));
  const sdkCache = new Map<string, (modelId: string) => LanguageModel>();

  const resolveModel = (modelId: string): LanguageModel => {
    const model = models.get(modelId);
    const npm = model?.provider?.npm?.toLowerCase() ?? opts.npm;
    const baseUrl = expandOptionalEndpoint(opts.baseUrl ?? model?.provider?.api, opts.id, modelId);
    const cacheKey = `${npm}\u0000${baseUrl ?? ''}`;
    let resolver = sdkCache.get(cacheKey);
    if (!resolver) {
      resolver = createResolver(npm, baseUrl, opts);
      sdkCache.set(cacheKey, resolver);
    }
    return resolver(modelId);
  };

  return new AiGatewayProvider({
    id: opts.id,
    // The generic bridge does not use this value when resolveModel is supplied.
    apiKey: opts.apiKey ?? 'native-credential-chain',
    capabilities: opts.capabilities,
    resolveModel,
  });
}

function createResolver(
  npm: string,
  baseUrl: string | undefined,
  opts: NativeCatalogProviderOptions,
): (modelId: string) => LanguageModel {
  if (opts.npm === 'ai-gateway-provider') {
    return createCloudflareResolver(npm, opts);
  }
  const common = {
    ...(baseUrl ? { baseURL: baseUrl } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  };

  switch (npm) {
    case '@ai-sdk/openai': {
      const sdk = createOpenAI(common);
      return (modelId) => sdk.responses(modelId);
    }
    case '@ai-sdk/openai-compatible': {
      if (opts.npm === '@ai-sdk/google-vertex') {
        const sdk = createGoogleVertexMaas({
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(opts.headers ? { headers: opts.headers } : {}),
          ...envSetting('project', 'GOOGLE_VERTEX_PROJECT'),
          ...envSetting('location', 'GOOGLE_VERTEX_LOCATION'),
        });
        return (modelId) => sdk(modelId);
      }
      const apiKey = requireApiKey(opts, npm);
      const apiBase = requireBaseUrl(baseUrl, opts.id, npm);
      const sdk = createUnified({
        apiKey,
        baseURL: apiBase,
        ...(opts.headers ? { headers: opts.headers } : {}),
      });
      return (modelId) => sdk(modelId);
    }
    case '@ai-sdk/anthropic': {
      if (opts.npm === '@ai-sdk/google-vertex') {
        const sdk = createGoogleVertexAnthropic({
          ...(baseUrl ? { baseURL: baseUrl } : {}),
          ...(opts.headers ? { headers: opts.headers } : {}),
          ...envSetting('project', 'GOOGLE_VERTEX_PROJECT'),
          ...envSetting('location', 'GOOGLE_VERTEX_LOCATION'),
        });
        return (modelId) => sdk(modelId);
      }
      const sdk = createAnthropic(common);
      return (modelId) => sdk(modelId);
    }
    case '@ai-sdk/google': {
      const sdk = createGoogleGenerativeAI(common);
      return (modelId) => sdk(modelId);
    }
    case '@ai-sdk/cohere': {
      const sdk = createCohere(common);
      return (modelId) => sdk(modelId);
    }
    case '@ai-sdk/azure': {
      const resourceName =
        opts.id === 'azure-cognitive-services'
          ? process.env['AZURE_COGNITIVE_SERVICES_RESOURCE_NAME']
          : process.env['AZURE_RESOURCE_NAME'];
      const sdk = createAzure({
        ...common,
        ...(resourceName && !baseUrl ? { resourceName } : {}),
      });
      return (modelId) => sdk.responses(modelId);
    }
    case '@ai-sdk/amazon-bedrock': {
      const sdk = createAmazonBedrock({
        ...common,
        ...envSetting('region', 'AWS_REGION'),
        ...envSetting('accessKeyId', 'AWS_ACCESS_KEY_ID'),
        ...envSetting('secretAccessKey', 'AWS_SECRET_ACCESS_KEY'),
        ...envSetting('sessionToken', 'AWS_SESSION_TOKEN'),
      });
      return (modelId) => sdk(modelId);
    }
    case '@ai-sdk/amazon-bedrock/mantle': {
      const sdk = createBedrockMantle({
        ...common,
        ...envSetting('region', 'AWS_REGION'),
        ...envSetting('accessKeyId', 'AWS_ACCESS_KEY_ID'),
        ...envSetting('secretAccessKey', 'AWS_SECRET_ACCESS_KEY'),
        ...envSetting('sessionToken', 'AWS_SESSION_TOKEN'),
      });
      return (modelId) => sdk.responses(modelId);
    }
    case '@ai-sdk/google-vertex': {
      const sdk = createGoogleVertex({
        ...common,
        ...envSetting('project', 'GOOGLE_VERTEX_PROJECT'),
        ...envSetting('location', 'GOOGLE_VERTEX_LOCATION'),
      });
      return (modelId) => sdk(modelId);
    }
    case '@ai-sdk/google-vertex/anthropic': {
      const sdk = createGoogleVertexAnthropic({
        ...(baseUrl ? { baseURL: baseUrl } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...envSetting('project', 'GOOGLE_VERTEX_PROJECT'),
        ...envSetting('location', 'GOOGLE_VERTEX_LOCATION'),
      });
      return (modelId) => sdk(modelId);
    }
    default:
      throw new ConfigError({
        message: `Provider "${opts.id}" requires unsupported native SDK "${npm}".`,
        code: 'CONFIG_INVALID',
      });
  }
}

function createCloudflareResolver(
  modelNpm: string,
  opts: NativeCatalogProviderOptions,
): (modelId: string) => LanguageModel {
  const apiKey = requireApiKey(opts, 'ai-gateway-provider');
  const accountId = requireEnvironment(opts.id, 'CLOUDFLARE_ACCOUNT_ID');
  const gatewayId = requireEnvironment(opts.id, 'CLOUDFLARE_GATEWAY_ID');

  if (modelNpm === '@ai-sdk/openai' || modelNpm === '@ai-sdk/anthropic') {
    const gateway = createCloudflareAiGateway({ accountId, gateway: gatewayId, apiKey });
    if (modelNpm === '@ai-sdk/openai') {
      const sdk = createOpenAI(opts.fetchImpl ? { fetch: opts.fetchImpl } : undefined);
      return (modelId) => gateway(sdk.responses(stripProviderPrefix(modelId, 'openai/')));
    }
    const sdk = createAnthropic(opts.fetchImpl ? { fetch: opts.fetchImpl } : undefined);
    return (modelId) => gateway(sdk(stripProviderPrefix(modelId, 'anthropic/')));
  }

  if (modelNpm === 'ai-gateway-provider') {
    const sdk = createUnified({
      apiKey,
      baseURL: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
      headers: { ...opts.headers, 'cf-aig-gateway-id': gatewayId },
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    });
    return (modelId) => sdk(modelId);
  }

  throw new ConfigError({
    message: `Cloudflare AI Gateway model requires unsupported SDK "${modelNpm}".`,
    code: 'CONFIG_INVALID',
  });
}

function stripProviderPrefix(modelId: string, prefix: string): string {
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId;
}

function requireEnvironment(providerId: string, name: string): string {
  const value = process.env[name];
  if (value) return value;
  throw new ConfigError({
    message: `Provider "${providerId}" requires environment ${name}.`,
    code: 'CONFIG_INVALID',
  });
}

function envSetting(name: string, envName: string): Record<string, string> {
  const value = process.env[envName];
  return value ? { [name]: value } : {};
}

function requireApiKey(opts: NativeCatalogProviderOptions, npm: string): string {
  if (opts.apiKey) return opts.apiKey;
  throw new ConfigError({
    message: `Provider "${opts.id}" requires an API key for ${npm}.`,
    code: 'CONFIG_INVALID',
  });
}

function requireBaseUrl(value: string | undefined, providerId: string, npm: string): string {
  if (value) return value;
  throw new ConfigError({
    message: `Provider "${providerId}" requires a model API endpoint for ${npm}.`,
    code: 'CONFIG_INVALID',
  });
}

function expandOptionalEndpoint(
  raw: string | undefined,
  providerId: string,
  modelId: string,
): string | undefined {
  if (!raw) return undefined;
  const missing = new Set<string>();
  const expanded = raw.replace(/\$\{([^}]+)\}/g, (token, name: string) => {
    const value = process.env[name];
    if (!value) {
      missing.add(name);
      return token;
    }
    return value;
  });
  if (missing.size > 0) {
    throw new ConfigError({
      message:
        `Provider "${providerId}" model "${modelId}" endpoint requires environment ` +
        `${[...missing].join(', ')}.`,
      code: 'CONFIG_INVALID',
    });
  }
  return expanded.replace(/\/+$/, '');
}
