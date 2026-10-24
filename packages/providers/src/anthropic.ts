import type {
  Capabilities,
  ProviderError,
  Request,
  StreamEvent,
} from '@wrongstack/contracts/types';
import { recordProviderQuota } from '@wrongstack/core/quota';
import { parseAnthropicRateLimitHeaders } from './anthropic-rate-limits.js';
import { type HeadersLike, parseProviderHttpError } from './error-parse.js';
import type { AnthropicStreamState } from './presets/anthropic.js';
import { anthropicWireFormat } from './presets/anthropic.js';
import { upstreamHost } from './proxy-upstream.js';
import { anthropicWireSigner, streamWithThinkingSigner } from './thinking-signer.js';
import type { WireAdapterStreamOptions } from './wire-adapter.js';
import { WireFormatProvider } from './wire-format.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  apiVersion?: string | undefined;
  beta?: string[] | undefined;
  fetchImpl?: typeof fetch | undefined;
  /**
   * Override the provider id surfaced on the `Provider` instance. Defaults to
   * the wire-format `cfg.id` (`'anthropic'`) when omitted so direct
   * `new AnthropicProvider({...})` callers — tests, plugins — keep their
   * expected `id === 'anthropic'` without having to opt in.
   *
   * Set this when a user-visible config provider (e.g. `minimax-token-plan`
   * with `family: 'anthropic'`) needs to keep its chosen id through the
   * Anthropic wire family. Without it, every Anthropic-compatible proxy
   * shows up in the status bar / provider pickers as plain `anthropic`.
   */
  id?: string | undefined;
  /** Raw stream debugging and hang-detection options. */
  streamOpts?: WireAdapterStreamOptions | undefined;
  /**
   * Maximum number of tool definitions the provider accepts per request.
   * When set, lower-priority tools are filtered out centrally by
   * `WireAdapter.stream()` before the request body is built.
   */
  maxTools?: number | undefined;
}

/**
 * Whether requests land on Anthropic itself. Read through a WrongProxy mount
 * (`localhost:PORT/proxy/api.anthropic.com/...`): the proxy forwards headers
 * as they are, so the auth header must match the upstream, not the hop.
 */
function isAnthropicHost(baseUrl: string): boolean {
  const host = upstreamHost(baseUrl);
  return host !== undefined && (host === 'anthropic.com' || host.endsWith('.anthropic.com'));
}

export class AnthropicProvider extends WireFormatProvider<AnthropicStreamState> {
  override readonly id: string;
  override readonly capabilities: Capabilities = anthropicWireFormat.capabilities;

  private readonly opts: AnthropicProviderOptions;

  constructor(opts: AnthropicProviderOptions) {
    super(anthropicWireFormat, {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl,
      fetchImpl: opts.fetchImpl,
      streamOpts: opts.streamOpts,
    });
    // Preserve a user-visible alias (e.g. 'minimax-token-plan' configured with
    // family 'anthropic') instead of collapsing it to the wire family's
    // canonical id. `cfg.id` is the wire-format default ('anthropic'); the
    // explicit opts override wins when present.
    this.id = opts.id ?? anthropicWireFormat.id;
    this.opts = opts;
    if (opts.maxTools && opts.maxTools > 0) {
      this.maxToolsCount = opts.maxTools;
    }
  }

  /**
   * Thinking blocks are signed by the service that produced them, and only
   * that service can be trusted to take them back (Anthropic verifies; a
   * foreign signature is a 400). Blocks are stamped with this endpoint's
   * signer, other signers' blocks are filtered out before sending, and a
   * signature rejection is repaired once — see thinking-signer.ts.
   */
  override async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    yield* streamWithThinkingSigner(req, opts, anthropicWireSigner(this.baseUrl), (r) =>
      super.stream(r, opts),
    );
  }

  /**
   * Override buildHeaders to support proxy auth detection and custom beta headers.
   *
   * Third-party Anthropic-compatible proxies (kimi-for-coding, zai-coding-plan,
   * anyrouter, …) reject `x-api-key` and require `Authorization: Bearer`.
   * The preset always sends `x-api-key`; this override checks the base URL and
   * switches to Bearer auth when targeting a non-Anthropic host.
   */
  protected override buildHeaders(_req: Request): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': this.opts.apiVersion ?? '2023-06-01',
    };
    if (isAnthropicHost(this.baseUrl)) {
      headers['x-api-key'] = this.apiKey;
    } else {
      headers['authorization'] = `Bearer ${this.apiKey}`;
    }
    if (this.opts.beta && this.opts.beta.length > 0) {
      headers['anthropic-beta'] = this.opts.beta.join(',');
    }
    return headers;
  }

  protected override translateError(
    status: number,
    text: string,
    headers?: HeadersLike,
  ): ProviderError {
    return parseProviderHttpError(this.id, status, text, headers);
  }

  /**
   * Read the `anthropic-ratelimit-unified-*` family off a successful response.
   *
   * These headers are the only place a subscription login's remaining 5h/7d
   * allowance is reported, and they ride along on requests we are already
   * making. An API-key account — or a proxy that strips the family — reports
   * nothing here and the parser returns no snapshot, so this costs one header
   * lookup on those paths and never fabricates a reading.
   */
  protected override onResponseHeaders(headers: HeadersLike | undefined, _req: Request): void {
    const snapshots = parseAnthropicRateLimitHeaders(this.id, headers);
    if (snapshots.length > 0) recordProviderQuota(this.id, snapshots);
  }
}
