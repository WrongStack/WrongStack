import type {
  Capabilities,
  ModelsDevModel,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';
import { CatalogRoutedProvider } from './catalog-routed.js';

export interface OpenCodeZenProviderOptions {
  id?: string | undefined;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  models?: readonly ModelsDevModel[] | undefined;
}

/**
 * OpenCode Zen exposes four model-dependent transports under one key. The
 * models.dev per-model `provider.npm` value is authoritative. Models without
 * an override use the provider's catalog default; model names are never used
 * as a second routing catalog.
 */
export class OpenCodeZenProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities;
  private readonly router: CatalogRoutedProvider;

  constructor(opts: OpenCodeZenProviderOptions) {
    this.id = opts.id ?? 'opencode';
    this.router = new CatalogRoutedProvider({
      id: this.id,
      apiKey: opts.apiKey,
      defaultNpm: '@ai-sdk/openai-compatible',
      baseUrl: opts.baseUrl,
      baseUrlOverride: opts.baseUrl,
      headers: opts.headers,
      models: opts.models,
      fetchImpl: opts.fetchImpl,
    });
    this.capabilities = this.router.capabilities;
  }

  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    return this.router.stream(req, opts);
  }

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    return this.router.complete(req, opts);
  }
}
