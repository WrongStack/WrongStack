import type {
  Capabilities,
  ModelsDevModel,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';
import { capabilitiesForFamily } from './family-capabilities.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { OpenAIResponsesProvider } from './openai-responses.js';

export interface OpenCodeZenProviderOptions {
  id?: string | undefined;
  apiKey: string;
  baseUrl: string;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
  models?: readonly ModelsDevModel[] | undefined;
}

/**
 * OpenCode Zen exposes model-dependent OpenAI transports under one key:
 * GPT-5 models use `/responses`; the remaining catalog uses
 * `/chat/completions`.
 */
export class OpenCodeZenProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = capabilitiesForFamily('openai-compatible', {
    reasoning: true,
    tools: true,
  });

  private readonly chat: OpenAICompatibleProvider;
  private readonly responses: OpenAIResponsesProvider;

  constructor(opts: OpenCodeZenProviderOptions) {
    this.id = opts.id ?? 'opencode';
    this.chat = new OpenAICompatibleProvider({
      id: this.id,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      headers: opts.headers,
      fetchImpl: opts.fetchImpl,
    });
    this.responses = new OpenAIResponsesProvider({
      id: this.id,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      headers: opts.headers,
      fetchImpl: opts.fetchImpl,
    });
  }

  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    return this.delegate(req.model).stream(req, opts);
  }

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    return this.delegate(req.model).complete(req, opts);
  }

  private delegate(model: string): Provider {
    return usesResponsesEndpoint(model) ? this.responses : this.chat;
  }
}

export function usesResponsesEndpoint(model: string): boolean {
  return /^gpt-5(?:[.-]|$)/i.test(model);
}
