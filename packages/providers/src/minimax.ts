import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';
import { AnthropicProvider } from './anthropic.js';
import { capabilitiesForFamily } from './family-capabilities.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

const DEFAULT_ROOT = 'https://api.minimax.io';

export interface MiniMaxProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  id?: string | undefined;
  headers?: Record<string, string> | undefined;
  fetchImpl?: typeof fetch | undefined;
}

/**
 * Direct MiniMax transport. M-series models (M2.x and M3) are routed through
 * MiniMax's recommended Anthropic-compatible interface so interleaved
 * thinking/tool blocks retain their native structure and prompt-cache usage
 * (cache_read_input_tokens / cache_creation_input_tokens) is reported on the
 * `message_start` event. Models outside the M series keep the OpenAI
 * fallback.
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
      headers: opts.headers,
      fetchImpl: opts.fetchImpl,
    });
  }

  stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const provider = isMiniMaxMessagesModel(req.model) ? this.messages : this.chat;
    this.syncCapabilities(provider);
    return provider.stream(req, opts);
  }

  complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const provider = isMiniMaxMessagesModel(req.model) ? this.messages : this.chat;
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
  private readonly extraHeaders?: Record<string, string> | undefined;

  constructor(opts: MiniMaxProviderOptions & { baseUrl?: string }) {
    super({
      // Forward `id` so the Anthropic surface preserves the user-visible
      // provider id (e.g. 'minimax-coding-plan') instead of falling through
      // to anthropicWireFormat.id ('anthropic'). Without this, every error
      // attribution and `resolveMaxOutputTokens(ctx.providerId, req.model)`
      // catalog lookup on the messages path is misattributed to 'anthropic',
      // which silently misses the MiniMax catalog row.
      id: opts.id,
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
    });
    this.extraHeaders = opts.headers;
  }

  protected override buildHeaders(_req: Request): Record<string, string> {
    // Forward caller-supplied headers (proxy auth, tenant ids, routing keys),
    // strip any caller keys whose lowercase form matches a protected Anthropic
    // header (auth / version / content-type / accept) — HTTP header names are
    // case-insensitive, so a literal `delete headers['x-api-key']` would miss
    // caller keys like `X-Api-Key` or `x-API-key`. Then write the
    // provider-controlled headers last so they win over any caller values.
    // This provider hardcodes `x-api-key` regardless of host, so the protected
    // set is broader than AnthropicProvider's host-conditional choice.
    //
    // M3 now travels this surface after the routing fix; without this merge
    // any custom headers passed via MiniMaxProviderOptions.headers would be
    // silently dropped on M3.
    const PROTECTED = new Set([
      'x-api-key',
      'authorization',
      'anthropic-version',
      'content-type',
      'accept',
    ]);
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.extraHeaders ?? {})) {
      if (!PROTECTED.has(key.toLowerCase())) filtered[key] = value;
    }
    return {
      ...filtered,
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

function isMiniMaxMessagesModel(model: string): boolean {
  // M-series (M2.x and M3, plus any future m{n} releases) go through
  // MiniMax's Anthropic-compatible surface. Models outside the m-series
  // family keep the OpenAI-compatible fallback.
  return /^minimax-m\d/i.test(model);
}

function minimaxRoot(baseUrl: string | undefined): string {
  const raw = (baseUrl?.trim() || DEFAULT_ROOT).replace(/\/+$/, '');
  return raw.replace(/\/(?:anthropic(?:\/v1)?|v1)$/i, '');
}
