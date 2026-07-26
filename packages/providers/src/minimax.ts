import type { Capabilities, Provider, Request, Response, StreamEvent } from '@wrongstack/core/types';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import type { BuildBodyContext } from './model-output-limits.js';

const DEFAULT_ROOT = 'https://api.minimax.io';

export interface MiniMaxProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  id?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Direct MiniMax transport. M2.x is routed through MiniMax's recommended
 * Anthropic-compatible interface so interleaved thinking/tool blocks retain
 * their native structure. Unknown/newer models retain the OpenAI surface.
 */
export class MiniMaxProvider implements Provider {
  readonly id: string;
  readonly capabilities: Capabilities = capabilitiesForFamily('openai-compatible', {
    reasoning: true,
    tools: true,
  });

  private readonly chat: OpenAICompatibleProvider;
  private readonly messages: MiniMaxMessagesProvider;

  constructor(opts: MiniMaxProviderOptions) {
    this.id = opts.id ?? 'minimax';
    const root = minimaxRoot(opts.baseUrl);
    this.chat = new OpenAICompatibleProvider({
      id: this.id,
      apiKey: opts.apiKey,
      baseUrl: `${root}/v1`,
      headers: opts.headers,
      fetchImpl: opts.fetchImpl,
      quirks: { stripThinkTags: true },
    });
    this.messages = new MiniMaxMessagesProvider({
      id: this.id,
      apiKey: opts.apiKey,
      baseUrl: `${root}/anthropic`,
      fetchImpl: opts.fetchImpl,
    });
  }

  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const provider = isMiniMaxM2(req.model) ? this.messages : this.chat;
    this.syncCapabilities(provider);
    return provider.stream(req, opts);
  }

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const provider = isMiniMaxM2(req.model) ? this.messages : this.chat;
    this.syncCapabilities(provider);
    return provider.complete(req, opts);
  }

  private syncCapabilities(provider: Provider): void {
    Object.defineProperty(provider, 'capabilities', {
      value: this.capabilities,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

class MiniMaxMessagesProvider extends AnthropicProvider {
  protected override buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'x-api-key': this.apiKey,
    };
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    // MiniMax documents `thinking` as ignored on this compatibility surface;
    // omit the canonical control and let the always-reasoning model decide.
    return super.buildBody({ ...req, reasoning: undefined }, ctx);
  }
}

function isMiniMaxM2(model: string): boolean {
  return /^minimax-m2(?:\.|-|$)/i.test(model);
}

function minimaxRoot(baseUrl: string | undefined): string {
  const raw = (baseUrl?.trim() || DEFAULT_ROOT).replace(/\/+$/, '');
  return raw.replace(/\/(?:anthropic(?:\/v1)?|v1)$/i, '');
}
