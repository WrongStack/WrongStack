import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
} from '@wrongstack/core/types';
import { ConfigError, ParseError, ProviderError, StreamHangError } from '@wrongstack/core/types';
import { parseProviderHttpError, type HeadersLike } from './error-parse.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { isDebugStreamEnabled, pushDebugChunkStats } from './stream-debug-state.js';
import { isNodeReadable } from './object-utils.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';
import { Readable } from 'node:stream';
import { toErrorMessage } from '@wrongstack/core/utils';
import { filterToolsByMaxCount } from './tool-priority.js';

const STREAM_DEBUG_TEXT_ENCODER = new TextEncoder();

type Response2 = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null;
  /** Optional — custom fetchImpl fakes may omit it; Retry-After parsing degrades gracefully. */
  headers?: HeadersLike | undefined;
};

/** Configuration for WireAdapter stream-level debugging and hang detection. */
export interface WireAdapterStreamOptions {
  /**
   * When true, accumulate per-chunk stats into the shared debug-sink
   * (stream-debug-state.ts). The sink batches every 200 ms and pushes to
   * a registered callback. The CLI default callback writes to stderr; the
   * TUI replaces it with a reducer dispatch that renders in StatusBar line 3,
   * keeping all output inside Ink's layout.
   *
   * Controlled by WRONGSTACK_DEBUG_STREAM=1 env var or the runtime
   * /settings debug-stream toggle.
   */
  debugStream?: boolean | undefined;
  /**
   * Maximum time (ms) to wait for the next chunk of data before declaring
   * a stream hang. Default: 60_000 (60 seconds). Set to 0 to disable.
   * When a hang is detected, a StreamHangError is thrown so the agent
   * loop can retry the iteration.
   */
  streamHangTimeoutMs?: number | undefined;
  /**
   * Maximum time (ms) to wait for response HEADERS to arrive before aborting
   * the request. This bounds the header phase, which `streamHangTimeoutMs`
   * (a body-only, inter-chunk guard) does not cover: a proxy that accepts the
   * TCP connection but never sends a response line would otherwise hang until
   * the caller's own signal fires (forever, for long-lived signals). A header
   * timeout surfaces as a retryable ProviderError. Default: 60_000. Set to 0
   * to disable.
   */
  headersTimeoutMs?: number | undefined;
}

/** Validate fetchImpl response has required fields; normalize missing body to null. */
function validateResponse(res: unknown): asserts res is Response2 {
  const r = res as Record<string, unknown> | undefined;
  if (r === undefined || typeof r.ok !== 'boolean' || typeof r.status !== 'number') {
    throw new ParseError({
      message: 'fetchImpl returned invalid response shape — expected { ok, status, text, body }',
      source: 'wire-adapter',
    });
  }
  // If body is absent, null, or undefined on a plain object (not a native Response
  // with a read-only getter), normalize it to null so callers can safely use it.
  // Native Response objects always have a body getter — no mutation needed.
  if (!('body' in r) || r.body === undefined) {
    // Only set on plain objects — native Response.body is read-only
    const proto = Object.getPrototypeOf(r);
    if (proto === Object.prototype || proto === null) {
      r.body = null;
    }
  }
}

async function safeText(res: Response2): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Feed debug-chunk stats into the shared singleton sink. The sink batches
 * and throttles writes so the TUI can render them inside Ink's StatusBar
 * line 3 (~5 Hz) instead of raw stderr interfering with the terminal layout.
 */
function logRawChunk(
  _providerId: string,
  _chunkIndex: number,
  bytes: Uint8Array,
  deltaMs: number,
): void {
  pushDebugChunkStats(bytes.length, deltaMs);
}

const DEFAULT_STREAM_HANG_TIMEOUT_MS = 60_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 60_000;

/**
 * Shared HTTP mechanics for streaming providers.
 * Providers extend this to get:
 *   - canonical error handling (ProviderError with retryable flag)
 *   - SSE body parsing via parseSSE()
 *   - abort signal wiring
 *   - optional raw-stream debug logging
 *   - optional stream hang detection
 *
 * Subclasses implement the abstract members to provide their specific wire format.
 */
export abstract class WireAdapter implements Provider {
  abstract readonly id: string;
  abstract readonly capabilities: Capabilities;

  protected readonly debugStream: boolean;
  protected readonly streamHangTimeoutMs: number;
  protected readonly headersTimeoutMs: number;

  /**
   * Provider-imposed tool-count limit (0 or undefined = no limit). When > 0,
   * `stream()` filters `req.tools` down to this many entries before delegating
   * to `buildBody()`, so every wire family (OpenAI, Anthropic, Google, …)
   * gets the same guarantee without each adapter repeating the logic.
   * Set by subclasses from their provider-specific options/quirks.
   *
   * Public so consumers (e.g. the TUI status bar view model) can read it to
   * compute the dropped-tool count: `max(0, ctx.tools.length - maxToolsCount)`.
   */
  maxToolsCount: number = 0;

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    public readonly fetchImpl: typeof fetch = fetch,
    streamOpts: WireAdapterStreamOptions = {},
  ) {
    if (!apiKey) {
      throw new ConfigError({
        message: `${this.constructor.name}: apiKey required`,
        code: 'CONFIG_INVALID',
      });
    }
    if (!baseUrl?.trim()) {
      throw new ConfigError({
        message:
          `${this.constructor.name}: baseUrl required — specify the provider endpoint ` +
          '(e.g. "https://api.openai.com/v1" or "https://generativelanguage.googleapis.com/v1beta").',
        code: 'CONFIG_INVALID',
      });
    }
    this.debugStream = streamOpts.debugStream ?? false;
    this.streamHangTimeoutMs = streamOpts.streamHangTimeoutMs ?? DEFAULT_STREAM_HANG_TIMEOUT_MS;
    this.headersTimeoutMs = streamOpts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
  }

  // Module-scoped state keyed by provider id so warning suppression and
  // dedup survive provider rebuilds on /model switch and fallback hops.
  // Per-instance flags would reset with every new Provider construction.
  private static readonly _warnedProviders = new Set<string>();
  private static readonly _suppressedProviders = new Set<string>();

  /**
   * Suppress the one-time maxTools warning for this provider id. Set by the
   * TUI host when it takes over the terminal, since the status-bar chip
   * provides equivalent visibility without writing to stderr. Persists across
   * provider rebuilds (model switch, fallback hop) because it is keyed by
   * provider id, not instance.
   */
  suppressMaxToolsWarning(): void {
    WireAdapter._suppressedProviders.add(this.id);
  }

  /**
   * Apply the maxTools limit to a request, returning a possibly-filtered copy.
   * Centralized so both {@link stream} and provider overrides (e.g.
   * {@link GoogleProvider.stream}) share one implementation.
   *
   * Returns the original request reference unchanged when no filtering is
   * needed (no allocation, preserves WeakMap caches).
   */
  protected applyMaxToolsFilter(req: Request): Request {
    if (this.maxToolsCount <= 0 || !req.tools || req.tools.length <= this.maxToolsCount) {
      return req;
    }
    const filteredTools = filterToolsByMaxCount(req.tools, this.maxToolsCount);
    // Log the dropped tools once per session so the user knows tools were
    // omitted — conversation history may reference them.
    const droppedNames = req.tools.filter((t) => !filteredTools.includes(t)).map((t) => t.name);
    if (droppedNames.length > 0) {
      this.logMaxToolsWarning(droppedNames);
    }
    // If a specific tool was pinned via toolChoice but was filtered out,
    // fall back to 'auto' so the provider never receives a tool_choice
    // for a tool it wasn't given.
    const tc = req.toolChoice;
    const pinnedName = tc && typeof tc === 'object' ? tc.name : undefined;
    const droppedToolChoice =
      pinnedName !== undefined && !filteredTools.some((t) => t.name === pinnedName);
    return {
      ...req,
      tools: filteredTools,
      ...(droppedToolChoice ? { toolChoice: 'auto' as const } : {}),
    };
  }

  /**
   * Emit a one-time warning when the maxTools limit drops tools, so the user
   * knows conversation history may reference tools the model can no longer
   * call. Suppressed when the TUI owns the terminal (use the status-bar chip
   * instead).
   */
  private logMaxToolsWarning(droppedNames: string[]): void {
    if (
      WireAdapter._warnedProviders.has(this.id) ||
      WireAdapter._suppressedProviders.has(this.id) ||
      droppedNames.length === 0
    ) {
      return;
    }
    WireAdapter._warnedProviders.add(this.id);
    const preview = droppedNames.slice(0, 10).join(', ');
    const suffix = droppedNames.length > 10 ? ` (and ${droppedNames.length - 10} more)` : '';
    process.emitWarning(
      `Provider "${this.id}" maxTools limit (${this.maxToolsCount}) dropped ${droppedNames.length} tool(s): ${preview}${suffix}. Conversation history may reference unavailable tools.`,
      'MaxToolsWarning',
    );
  }

  async complete(req: Request, opts: { signal: AbortSignal }): Promise<Response> {
    const { aggregateStream } = await import('./aggregate.js');
    return aggregateStream(this.stream(req, opts));
  }

  async *stream(req: Request, opts: { signal: AbortSignal }): AsyncIterable<StreamEvent> {
    const url = this.buildUrl(req);
    const headers = this.buildHeaders(req);
    // Apply the provider-imposed tool-count limit centrally so every wire
    // family (OpenAI, Anthropic, Google, …) gets the same guarantee without
    // each buildBody repeating the logic.
    const effectiveReq = this.applyMaxToolsFilter(req);
    // Subclasses with their own buildBody (anthropic, openai, openai-codex,
    // openai-compatible, github-copilot) size the response from this context
    // via `resolveMaxOutputTokens`. `providerId` is what lets that lookup hit
    // the catalog for `req.model` — `capabilities` alone is provider-scoped
    // and goes stale the moment the session switches model.
    const body = this.buildBody(effectiveReq, {
      capabilities: this.capabilities,
      providerId: this.id,
    });

    // Linked abort: forward the caller's signal to a controller we ALSO trip
    // if response headers never arrive. `streamHangTimeoutMs` only guards the
    // body's inter-chunk gaps; without this, a proxy that accepts the socket
    // but never sends headers hangs until the caller's signal fires. The
    // header timer is cleared the moment headers arrive, so it never truncates
    // the body — the caller's signal continues to drive cancellation for the
    // whole stream lifetime.
    const linked = new AbortController();
    const forwardAbort = () => linked.abort((opts.signal as { reason?: unknown }).reason);
    if (opts.signal.aborted) linked.abort((opts.signal as { reason?: unknown }).reason);
    else opts.signal.addEventListener('abort', forwardAbort, { once: true });
    let headersTimedOut = false;
    const headersTimer =
      this.headersTimeoutMs > 0
        ? setTimeout(() => {
            headersTimedOut = true;
            linked.abort();
          }, this.headersTimeoutMs)
        : undefined;
    if (headersTimer && typeof headersTimer.unref === 'function') headersTimer.unref();

    try {
      let httpRes: Response2;
      try {
        // Redirects are followed manually so a cross-origin hop cannot replay
        // `x-api-key` / `x-goog-api-key` / custom gateway headers to a host the
        // user never configured — fetch only strips Authorization/Cookie (WS-084).
        const raw = await redirectSafeFetch(this.fetchImpl, url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: linked.signal,
        });
        validateResponse(raw);
        httpRes = raw as Response2;
      } catch (err) {
        // Caller cancelled — propagate the raw abort untouched.
        if (opts.signal.aborted) throw err;
        // Our header timer tripped: classify as a (retryable) stream hang so
        // the agent loop retries rather than surfacing a dead turn.
        if (headersTimedOut) {
          throw new StreamHangError({
            providerId: this.id,
            model: req.model,
            hangTimeoutMs: this.headersTimeoutMs,
            bytesReceived: 0,
            elapsedMs: this.headersTimeoutMs,
            cause: err,
          });
        }
        // Any other pre-body fetch failure → retryable.
        throw new ProviderError(toErrorMessage(err), 0, true, this.id, {
          cause: err,
          body: { message: toErrorMessage(err) },
        });
      } finally {
        if (headersTimer) clearTimeout(headersTimer);
      }

      if (!httpRes.ok) {
        const text = await safeText(httpRes);
        throw this.translateError(httpRes.status, text, httpRes.headers);
      }

      let sseBody = httpRes.body;
      if (!sseBody) {
        // No body — emit nothing
        return;
      }

      // Layer 1: debug logging — wrap the stream to log raw bytes.
      // Checks both the instance-level option (set at construction) AND the
      // runtime singleton (flipped via /settings or setDebugStreamEnabled) so
      // toggles take effect on the next request without recreating providers.
      if (this.debugStream || isDebugStreamEnabled()) {
        sseBody = this.wrapDebugStream(sseBody);
      }

      // Layer 2: hang detection — wrap with timeout-aware reader
      if (this.streamHangTimeoutMs > 0) {
        sseBody = this.wrapWithHangDetection(sseBody, req.model);
      }

      // Consume the SSE body through a try/catch that normalises transport-level
      // errors (TypeError: terminated, fetch failed, ECONNRESET, etc.) into
      // retryable ProviderErrors. These can fire after the HTTP response headers
      // have already been received (e.g. Undici closes the connection mid-stream),
      // so the fetch-level catch block above does not cover them.
      try {
        yield* this.parseStream(sseBody, effectiveReq.model, effectiveReq);
      } catch (err) {
        if (opts.signal.aborted || err instanceof ProviderError) throw err;
        // Transport-shaped errors below this point become retryable network errors.
        const message = toErrorMessage(err);
        if (
          err instanceof TypeError &&
          /terminated|fetch failed|ECONNRESET|ETIMEDOUT|UND_ERR_/i.test(message)
        ) {
          throw new ProviderError(message, 0, true, this.id, {
            cause: err,
            body: { message },
          });
        }
        throw err;
      }
    } finally {
      opts.signal.removeEventListener('abort', forwardAbort);
    }
  }

  /**
   * Wrap a readable stream body to log a compact status line per incoming
   * byte chunk to stderr. This is a diagnostic tool for tracking stream
   * activity — chunk count, sizes, and inter-chunk deltas — without
   * printing payload contents.
   */
  private wrapDebugStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
  ): ReadableStream<Uint8Array> | NodeJS.ReadableStream {
    // Node.js Readable stream — use async iterator
    if (isNodeReadable(body)) {
      return this.wrapDebugNodeStream(body as NodeJS.ReadableStream) as NodeJS.ReadableStream;
    }
    // Web ReadableStream — wrap reader
    return this.wrapDebugWebStream(body as ReadableStream<Uint8Array>);
  }

  private wrapDebugNodeStream(body: NodeJS.ReadableStream): NodeJS.ReadableStream {
    let lastChunkTime = Date.now();
    let chunkIndex = 0;
    const providerId = this.id;

    return Readable.from(
      (async function* () {
        for await (const chunk of body) {
          const bytes: Uint8Array =
            typeof chunk === 'string'
              ? STREAM_DEBUG_TEXT_ENCODER.encode(chunk)
              : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          const now = Date.now();
          logRawChunk(providerId, chunkIndex++, bytes, now - lastChunkTime);
          lastChunkTime = now;
          yield chunk;
        }
      })(),
    );
  }

  private wrapDebugWebStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
    let lastChunkTime = Date.now();
    let chunkIndex = 0;
    const self = this;
    const reader = body.getReader();

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) {
          const now = Date.now();
          logRawChunk(self.id, chunkIndex++, value, now - lastChunkTime);
          lastChunkTime = now;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        reader.cancel(reason);
      },
    });
  }

  /**
   * Wrap a readable stream to detect hangs — when no data arrives for
   * longer than `streamHangTimeoutMs`. When a hang is detected, throws
   * `StreamHangError` so the caller can retry or fall back.
   */
  private wrapWithHangDetection(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
    model: string,
  ): ReadableStream<Uint8Array> | NodeJS.ReadableStream {
    if (isNodeReadable(body)) {
      return this.wrapHangNodeStream(body as NodeJS.ReadableStream, model);
    }
    return this.wrapHangWebStream(body as ReadableStream<Uint8Array>, model);
  }

  private wrapHangNodeStream(body: NodeJS.ReadableStream, model: string): NodeJS.ReadableStream {
    // Node Readable → Web ReadableStream, then use the race-based
    // web wrapper that properly detects hangs even when no chunks arrive.
    // The for-await approach only checks BETWEEN chunks — a stalled stream
    // that never yields another chunk would freeze indefinitely.
    const webStream = Readable.toWeb(body as Readable);
    const wrappedWeb = this.wrapHangWebStream(webStream as ReadableStream<Uint8Array>, model);
    return Readable.fromWeb(
      wrappedWeb as never as ReadableStream,
    ) as never as NodeJS.ReadableStream;
  }

  private wrapHangWebStream(
    body: ReadableStream<Uint8Array>,
    model: string,
  ): ReadableStream<Uint8Array> {
    const startTime = Date.now();
    let bytesReceived = 0;
    const timeout = this.streamHangTimeoutMs;
    const providerId = this.id;
    const reader = body.getReader();

    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Race the read against a hang timeout
        const readPromise = reader.read();
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ timedOut: true }), timeout);
        });

        let result: { done: boolean; value?: Uint8Array | undefined } | { timedOut: true };
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }

        if ('timedOut' in result && result.timedOut) {
          // The read is still pending — this is a hang.
          // Cancel the reader and throw.
          reader
            .cancel('stream hang detected')
            .catch((err) =>
              console.debug(`[wire-adapter] cancel after stream hang failed: ${err}`),
            );
          const elapsedMs = Date.now() - startTime;
          throw new StreamHangError({
            providerId,
            model,
            hangTimeoutMs: timeout,
            bytesReceived,
            elapsedMs,
          });
        }

        const { done, value } = result as Awaited<ReturnType<typeof reader.read>>;
        if (done) {
          controller.close();
          return;
        }
        if (value) {
          bytesReceived += value.length;
        }
        controller.enqueue(value);
      },
      cancel(reason) {
        reader.cancel(reason);
      },
    });
  }

  // ─── Abstract / overridable ───────────────────────────────────────────────

  /** HTTP endpoint for this provider's chat completions / messages API. */
  protected abstract buildUrl(req: Request): string;

  /** Per-request headers. `apiKey` is already in scope — call `super.buildHeaders` first. */
  protected buildHeaders(_req: Request): Record<string, string> {
    return {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
  }

  /** Map Request fields to the wire request body. Receives the provider's
   *  resolved `Capabilities` and id so the body can size the response with
   *  `resolveMaxOutputTokens(req, ctx)` when `req.maxTokens` is undefined. */
  protected abstract buildBody(req: Request, ctx: BuildBodyContext): Record<string, unknown>;

  /** Translate wire SSE events into canonical StreamEvent[]. */
  protected abstract parseStream(
    body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null,
    fallbackModel: string,
    req: Request,
  ): AsyncIterable<StreamEvent>;

  /** Build a ProviderError from an HTTP failure response. `headers` (when the
   *  fetch impl provides them) lets the parser honour Retry-After hints. */
  protected translateError(status: number, body: string, headers?: HeadersLike): ProviderError {
    return parseProviderHttpError(this.id, status, body, headers);
  }
}
