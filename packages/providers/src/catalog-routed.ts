import type {
  Capabilities,
  ModelsDevModel,
  Provider,
  Request,
  Response,
  StreamEvent,
  WireFamily,
} from '@wrongstack/core/types';
import { ConfigError } from '@wrongstack/core/types';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { GoogleProvider } from './google.js';
import { type CompatibilityQuirks, OpenAICompatibleProvider } from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

export type CatalogWireNpm =
  | '@ai-sdk/openai'
  | '@ai-sdk/openai-compatible'
  | '@ai-sdk/anthropic'
  | '@ai-sdk/google';

const FAMILY_BY_CATALOG_NPM: Readonly<Record<CatalogWireNpm, WireFamily>> = {
  '@ai-sdk/openai': 'openai',
  '@ai-sdk/openai-compatible': 'openai-compatible',
  '@ai-sdk/anthropic': 'anthropic',
  '@ai-sdk/google': 'google',
};

export function isCatalogWireNpm(value: string | undefined): value is CatalogWireNpm {
  return value !== undefined && value in FAMILY_BY_CATALOG_NPM;
}

export interface CatalogRoutedProviderOptions {
  id: string;
  apiKey: string;
  defaultNpm: CatalogWireNpm;
  baseUrl?: string | undefined;
  /** A config base URL overrides every catalog model endpoint when present. */
  baseUrlOverride?: string | undefined;
  headers?: Record<string, string> | undefined;
  models?: readonly ModelsDevModel[] | undefined;
  quirks?: CompatibilityQuirks | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Routes one catalog provider across the native wire protocol declared by
 * each model's `provider.npm`. Delegates are cached by (wire, endpoint), since
 * mixed providers such as OFox and ZenMux also publish per-model API roots.
 */
export class CatalogRoutedProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities;

  private readonly models: ReadonlyMap<string, ModelsDevModel>;
  private readonly delegates = new Map<string, Provider>();

  constructor(private readonly opts: CatalogRoutedProviderOptions) {
    this.id = opts.id;
    this.models = new Map((opts.models ?? []).map((model) => [model.id, model]));
    this.capabilities = capabilitiesForFamily(FAMILY_BY_CATALOG_NPM[opts.defaultNpm], {
      reasoning: true,
      tools: true,
    });
  }

  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    return this.delegate(req.model).stream(req, opts);
  }

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    return this.delegate(req.model).complete(req, opts);
  }

  private delegate(modelId: string): Provider {
    const model = this.models.get(modelId);
    const declaredNpm = model?.provider?.npm?.toLowerCase();
    if (declaredNpm !== undefined && !isCatalogWireNpm(declaredNpm)) {
      throw new ConfigError({
        message:
          `Provider "${this.id}" model "${modelId}" requires unsupported wire SDK ` +
          `"${declaredNpm}".`,
        code: 'CONFIG_INVALID',
      });
    }
    const npm = declaredNpm ?? this.opts.defaultNpm;
    const rawBaseUrl = this.opts.baseUrlOverride ?? model?.provider?.api ?? this.opts.baseUrl;
    const baseUrl = expandEndpoint(rawBaseUrl, this.id, modelId);
    const cacheKey = `${npm}\u0000${baseUrl}`;
    const cached = this.delegates.get(cacheKey);
    if (cached) return cached;

    const common = {
      id: this.id,
      apiKey: this.opts.apiKey,
      baseUrl,
      headers: this.opts.headers,
      fetchImpl: this.opts.fetchImpl,
    };
    const delegate: Provider =
      npm === '@ai-sdk/openai'
        ? new OpenAIResponsesProvider(common)
        : npm === '@ai-sdk/anthropic'
          ? new CatalogAnthropicProvider(common)
          : npm === '@ai-sdk/google'
            ? new CatalogGoogleProvider(common)
            : new OpenAICompatibleProvider({ ...common, quirks: this.opts.quirks });
    this.delegates.set(cacheKey, delegate);
    return delegate;
  }
}

function expandEndpoint(raw: string | undefined, providerId: string, modelId: string): string {
  if (!raw?.trim()) {
    throw new ConfigError({
      message: `Provider "${providerId}" has no API endpoint for model "${modelId}".`,
      code: 'CONFIG_INVALID',
    });
  }
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

interface CatalogDelegateOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

class CatalogAnthropicProvider extends AnthropicProvider {
  private readonly extraHeaders?: Record<string, string> | undefined;

  constructor(opts: CatalogDelegateOptions) {
    super(opts);
    this.extraHeaders = opts.headers;
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    return {
      ...filterHeaders(this.extraHeaders, [
        'x-api-key',
        'authorization',
        'anthropic-version',
        'content-type',
        'accept',
      ]),
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      // Match @ai-sdk/anthropic semantics for catalog entries that explicitly
      // select that SDK, including gateways whose host is not anthropic.com.
      'x-api-key': this.apiKey,
    };
  }
}

class CatalogGoogleProvider extends GoogleProvider {
  private readonly extraHeaders?: Record<string, string> | undefined;

  constructor(opts: CatalogDelegateOptions) {
    super(opts);
    this.extraHeaders = opts.headers;
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...filterHeaders(this.extraHeaders, ['x-goog-api-key', 'content-type', 'accept']),
      ...super.buildHeaders(req),
    };
  }
}

function filterHeaders(
  headers: Record<string, string> | undefined,
  protectedNames: readonly string[],
): Record<string, string> {
  const protectedSet = new Set(protectedNames);
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([key]) => !protectedSet.has(key.toLowerCase())),
  );
}
