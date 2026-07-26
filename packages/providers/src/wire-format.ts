import type {
  Capabilities,
  Provider,
  ProviderFactory,
  Request,
  StreamEvent,
  WireFamily,
} from '@wrongstack/core/types';
import { ConfigError, ProviderError } from '@wrongstack/core/types';
import {
  type HeadersLike,
  parseProviderHttpError,
  retryAfterMsFromHeaders,
} from './error-parse.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { type SSEMessage, parseSSE } from './sse.js';
import { WireAdapter, type WireAdapterStreamOptions } from './wire-adapter.js';

/**
 * Declarative wire-format definition. Sufficient to add a new HTTP+SSE
 * provider without subclassing `WireAdapter` — the boilerplate (HTTP errors,
 * abort wiring, SSE body parsing) is shared.
 *
 * The shape covers the variation that actually matters between providers:
 *   - URL template (path, query)
 *   - Auth headers (x-api-key, Authorization, etc.)
 *   - Request body (field names, system-prompt placement, tool format)
 *   - SSE event translation (one wire event → 0+ canonical events)
 *
 * Anything more exotic (non-SSE streams, multipart bodies, OAuth flows) still
 * needs a hand-written subclass — those cases are too varied to template.
 *
 * `S` is provider-internal state threaded across SSE events for one stream:
 * accumulating partial tool-call JSON, tracking block kinds, carrying the
 * model id forward from `message_start`, etc. Each `stream()` call gets a
 * fresh `S` via `createStreamState`.
 */
export interface WireFormatConfig<S = Record<string, unknown>> {
  /** Provider id (matches catalog id when the provider is in models.dev). */
  id: string;
  /** Wire family — used by the registry's factory list. */
  family: WireFamily;
  capabilities: Capabilities;
  /** Used when the user doesn't override via config.baseUrl. */
  defaultBaseUrl: string;
  /** Build the HTTPS endpoint. Receives the (possibly user-overridden) base URL. */
  buildUrl(baseUrl: string, req: Request): string;
  /** Per-request headers. Default `content-type`/`accept` are provided already. */
  buildHeaders(apiKey: string, req: Request): Record<string, string>;
  /** Map a canonical Request onto the provider's body shape.
   *  Receives the provider's resolved `Capabilities` and its id; pass both to
   *  `resolveMaxOutputTokens(req, ctx)` rather than reading
   *  `ctx.capabilities.maxOutput` directly. Capabilities are provider-scoped
   *  and resolved once at boot, so they describe the model the session
   *  started on — the catalog lookup keyed on `req.model` is what stays
   *  correct across `/model` switches, fallback hops and subagents. */
  buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown>;
  /** Construct fresh per-stream state. Called once per `stream()` call. */
  createStreamState(fallbackModel: string): S;
  /**
   * Translate one SSE event into 0+ canonical events. Mutating `state` is
   * expected — providers carry per-stream accumulators (partial tool JSON,
   * current model id, usage) here.
   */
  parseStreamEvent(msg: SSEMessage, state: S): StreamEvent[];
  /**
   * Optional: yield any final events after the upstream stream closes
   * (e.g. emit a synthetic `message_stop` when the wire format ends with
   * `[DONE]` instead of an explicit terminator).
   */
  finalizeStream?(state: S): StreamEvent[];
  /**
   * Optional: report whether the stream closed WITHOUT a terminal marker
   * (e.g. OpenAI's `[DONE]` / a `finish_reason`). A clean mid-stream FIN from
   * a proxy/LB idle timeout otherwise reaches `finalizeStream`, which happily
   * synthesizes a `message_stop` with the default `end_turn` — committing a
   * truncated response to history as if it finished. When this returns true,
   * `runStream` throws a retryable error instead so the agent loop retries.
   */
  isTruncated?(state: S): boolean;
  /** Optional override; defaults to the shared HTTP error parser. `headers`
   *  (when the fetch impl provides them) carries Retry-After hints — impls
   *  may ignore it; the wire format backfills `body.retryAfterMs` either way. */
  normalizeError?(status: number, body: string, headers?: HeadersLike): ProviderError;
}

/**
 * Concrete Provider built from a declarative config. Extends WireAdapter to
 * inherit the canonical HTTP + abort + error machinery.
 */
export class WireFormatProvider<S = Record<string, unknown>> extends WireAdapter {
  override readonly id: string;
  override readonly capabilities: Capabilities;
  private readonly cfg: WireFormatConfig<S>;

  constructor(
    cfg: WireFormatConfig<S>,
    opts: {
      apiKey: string;
      baseUrl?: string | undefined;
      fetchImpl?: typeof fetch | undefined;
      streamOpts?: WireAdapterStreamOptions | undefined;
    },
  ) {
    super(opts.apiKey, opts.baseUrl ?? cfg.defaultBaseUrl, opts.fetchImpl, opts.streamOpts);
    this.id = cfg.id;
    this.capabilities = cfg.capabilities;
    this.cfg = cfg;
  }

  protected override buildUrl(req: Request): string {
    return this.cfg.buildUrl(this.baseUrl, req);
  }

  protected override buildHeaders(req: Request): Record<string, string> {
    return {
      ...super.buildHeaders(req),
      ...this.cfg.buildHeaders(this.apiKey, req),
    };
  }

  protected override buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown> {
    // Forward the whole context (capabilities + provider id) so the preset can
    // resolve the model's real output ceiling for `req.model`.
    return this.cfg.buildBody(req, ctx);
  }

  protected override parseStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    return this.runStream(body, fallbackModel);
  }

  protected override translateError(
    status: number,
    body: string,
    headers?: HeadersLike,
  ): ProviderError {
    const err = this.cfg.normalizeError
      ? this.cfg.normalizeError(status, body, headers)
      : parseProviderHttpError(this.id, status, body, headers);
    // Custom normalizers rarely parse headers themselves — backfill the
    // Retry-After hint so retry policies can honour it regardless of impl.
    if (err.body && err.body.retryAfterMs === undefined) {
      const hint = retryAfterMsFromHeaders(headers);
      if (hint !== undefined) err.body.retryAfterMs = hint;
    }
    return err;
  }

  private async *runStream(
    body: Parameters<typeof parseSSE>[0],
    fallbackModel: string,
  ): AsyncIterable<StreamEvent> {
    const state = this.cfg.createStreamState(fallbackModel);
    for await (const msg of parseSSE(body)) {
      for (const ev of this.cfg.parseStreamEvent(msg, state)) {
        yield ev;
      }
    }
    // The upstream closed. If it did so without a terminal marker, the response
    // was cut mid-stream — surface a retryable error rather than letting
    // finalizeStream synthesize a clean end_turn over truncated content.
    if (this.cfg.isTruncated?.(state)) {
      throw new ProviderError(
        'Provider stream ended without a terminal marker ([DONE]/finish_reason) — response truncated mid-stream',
        599,
        true,
        this.id,
        { body: { message: 'stream truncated before completion' } },
      );
    }
    if (this.cfg.finalizeStream) {
      for (const ev of this.cfg.finalizeStream(state)) {
        yield ev;
      }
    }
  }
}

/**
 * Identity helper that gives authors type checking on the config literal.
 * Use at module level:
 *
 *   export const myProvider = defineWireFormat({
 *     id: 'mistral',
 *     family: 'openai-compatible',
 *     capabilities: { ... },
 *     ...
 *   });
 */
export function defineWireFormat<S = Record<string, unknown>>(
  cfg: WireFormatConfig<S>,
): WireFormatConfig<S> {
  return cfg;
}

export interface WireFactoryOptions {
  /**
   * Optional config-time override of the API key. When omitted, the factory
   * reads `cfg.apiKey` (passed in at create time by the registry / config
   * loader). Setting this here is useful in tests.
   */
  apiKey?: string | undefined;
  /** Override the base URL at factory build time. */
  baseUrl?: string | undefined;
}

/**
 * Build a `ProviderFactory` from a declarative wire-format. Plug into
 * `ProviderRegistry.register(...)` or use in `buildProviderFactoriesFromRegistry`
 * for catalog-driven discovery.
 */
export function createWireFormatFactory<S>(
  cfg: WireFormatConfig<S>,
  opts: WireFactoryOptions = {},
): ProviderFactory {
  return {
    type: cfg.id,
    family: cfg.family,
    create: (rawCfg: unknown): Provider => {
      const c = rawCfg as { apiKey?: string | undefined; baseUrl?: string | undefined };
      const apiKey = opts.apiKey ?? c.apiKey;
      if (!apiKey) {
        throw new ConfigError({
          message: `Provider "${cfg.id}" requires an apiKey.`,
          code: 'CONFIG_INVALID',
        });
      }
      return new WireFormatProvider(cfg, {
        apiKey,
        baseUrl: opts.baseUrl ?? c.baseUrl,
      });
    },
  };
}
