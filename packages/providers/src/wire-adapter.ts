import type {
  Capabilities,
  Provider,
  Request,
  Response,
  StreamEvent,
  Tool,
} from '@wrongstack/contracts/types';
import {
  ConfigError,
  ParseError,
  ProviderError,
  StreamHangError,
} from '@wrongstack/contracts/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { warmConnection } from './connection-warmup.js';
import { type HeadersLike, parseProviderHttpError } from './error-parse.js';
import type { BuildBodyContext } from './model-output-limits.js';
import { redirectSafeFetch } from './redirect-safe-fetch.js';
import { isDebugStreamEnabled } from './stream-debug-state.js';
import { streamBudget } from './stream-timeout-floors.js';
import { streamTimeoutDefaults } from './stream-timeouts.js';
import { filterToolsByMaxCount } from './tool-priority.js';
import { wrapDebugStream, wrapWithHangDetection } from './wire-stream-wrappers.js';

/** A `\udXXX` escape not preceded by an escaping backslash (`\\ud83d` is literal text). */
const UNPAIRED_SURROGATE_ESCAPE = /(?<!\\)((?:\\\\)*)\\ud[89a-f][0-9a-f]{2}/g;

/**
 * The request body as JSON with no lone surrogates. Text cut at a UTF-16 unit
 * count inside an emoji (error excerpts, hook reasons, output caps) leaves one
 * half, which JSON.stringify emits as an unpaired `\udXXX` escape: ill-formed
 * Unicode in the request. Valid pairs are emitted raw, so every such escape is
 * a lone half; it becomes U+FFFD.
 */
function stringifyRequestBody(body: unknown): string {
  const json = JSON.stringify(body);
  return json.includes('\\ud') ? json.replace(UNPAIRED_SURROGATE_ESCAPE, '$1\\ufffd') : json;
}

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
   * a stream hang. Defaults to the host's configured value
   * (`stream-timeouts.ts`), itself 60_000. Set to 0 to disable.
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
   * timeout surfaces as a retryable ProviderError. Defaults to the host's
   * configured value (`stream-timeouts.ts`), itself 60_000. Set to 0 to
   * disable.
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
  private readonly hangBudget: { value: number; explicit: boolean };
  private readonly headersBudget: { value: number; explicit: boolean };

  /**
   * Resolved at construction, but the slow-backend floor needs `id`, which a
   * subclass field sets only after this constructor returns — so it applies
   * on read.
   */
  protected get streamHangTimeoutMs(): number {
    const { value, explicit } = this.hangBudget;
    return streamBudget('hang', value, explicit, this.id, this.baseUrl);
  }

  protected get headersTimeoutMs(): number {
    const { value, explicit } = this.headersBudget;
    return streamBudget('headers', value, explicit, this.id, this.baseUrl);
  }

  /**
   * Provider-imposed tool-count limit (0 or undefined = no limit). When > 0,
   * `stream()` filters `req.tools` down to this many entries before delegating
   * to `buildBody()`, so every wire family (OpenAI, Anthropic, Google, …)
   * gets the same guarantee without each adapter repeating the logic.
   * Set by subclasses from their provider-specific options/quirks.
   *
   * Public so diagnostics can compare the candidate direct surface with this
   * cap. `ctx.tools` already contains the final provider selection.
   */
  maxToolsCount: number = 0;
  private toolSelectionCache:
    | {
        source: Tool[];
        sourceItems: Tool[];
        sourceNames: string[];
        limit: number;
        selected: Tool[];
      }
    | undefined;

  constructor(
    protected readonly apiKey: string,
    protected readonly baseUrl: string,
    public readonly fetchImpl: typeof fetch = fetch,
    streamOpts: WireAdapterStreamOptions = {},
  ) {
    if (!apiKey?.trim()) {
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
    // Per-instance options win; otherwise the host's configured defaults
    // (stream-timeouts.ts), which fall back to 60s/60s.
    const hostDefaults = streamTimeoutDefaults();
    this.debugStream = streamOpts.debugStream ?? false;
    this.hangBudget = {
      value: streamOpts.streamHangTimeoutMs ?? hostDefaults.hangTimeoutMs,
      explicit: streamOpts.streamHangTimeoutMs !== undefined,
    };
    this.headersBudget = {
      value: streamOpts.headersTimeoutMs ?? hostDefaults.headersTimeoutMs,
      explicit: streamOpts.headersTimeoutMs !== undefined,
    };
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
   * Resolve maxTools before prompt composition. The wire also uses this as a
   * backstop for standalone requests. Stable selections retain array identity
   * for prompt caching and context accounting.
   */
  selectToolsForRequest(tools: Tool[]): Tool[] {
    if (this.maxToolsCount <= 0 || tools.length <= this.maxToolsCount) return tools;
    const cached = this.toolSelectionCache;
    if (
      cached?.source === tools &&
      cached.limit === this.maxToolsCount &&
      cached.sourceItems.length === tools.length &&
      cached.sourceItems.every(
        (tool, index) => tool === tools[index] && cached.sourceNames[index] === tools[index]?.name,
      )
    ) {
      return cached.selected;
    }
    const filteredTools = filterToolsByMaxCount(tools, this.maxToolsCount);
    // Log the dropped tools once per session so the user knows tools were
    // omitted — conversation history may reference them.
    const droppedNames = tools.filter((t) => !filteredTools.includes(t)).map((t) => t.name);
    if (droppedNames.length > 0) {
      this.logMaxToolsWarning(droppedNames);
    }
    this.toolSelectionCache = {
      source: tools,
      sourceItems: [...tools],
      sourceNames: tools.map((tool) => tool.name),
      limit: this.maxToolsCount,
      selected: filteredTools,
    };
    return filteredTools;
  }

  protected applyMaxToolsFilter(req: Request): Request {
    if (!req.tools) return req;
    const filteredTools = this.selectToolsForRequest(req.tools);
    if (filteredTools === req.tools) return req;
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

  warm(_model: string): Promise<void> {
    return warmConnection(this.baseUrl, this.fetchImpl);
  }

  /**
   * One non-streaming JSON POST with this provider's credentials, for the
   * side APIs a chat wire does not cover (image generation). Redirects stay
   * same-origin like the chat path; a non-2xx status becomes this provider's
   * own `ProviderError`.
   */
  protected async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    let res: Response2;
    try {
      const raw = await redirectSafeFetch(this.fetchImpl, url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' },
        body: stringifyRequestBody(body),
        signal,
      });
      validateResponse(raw);
      res = raw as Response2;
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ProviderError(toErrorMessage(err), 0, true, this.id, {
        cause: err,
        body: { message: toErrorMessage(err) },
      });
    }
    const text = await safeText(res);
    if (!res.ok) throw this.translateError(res.status, text, res.headers);
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new ProviderError(`${this.id}: response is not JSON`, res.status, false, this.id, {
        cause: err,
        body: { message: text.slice(0, 500) },
      });
    }
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
          body: this.encodeRequestBody(stringifyRequestBody(body), headers),
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

      // Successful-response headers carry out-of-band signals that never appear
      // in the SSE body: subscription quota (`x-codex-*`), sticky routing
      // tokens, catalog etags. `translateError` already receives the headers on
      // the failure path; this is the same courtesy for the success path.
      // Base implementation is a no-op, so no wire family pays for it.
      try {
        this.onResponseHeaders(httpRes.headers, effectiveReq);
      } catch {
        // Observability must never break a live stream.
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
        sseBody = wrapDebugStream(this.id, sseBody);
      }

      // Layer 2: hang detection — wrap with timeout-aware reader
      if (this.streamHangTimeoutMs > 0) {
        sseBody = wrapWithHangDetection(sseBody, {
          providerId: this.id,
          model: req.model,
          timeoutMs: this.streamHangTimeoutMs,
        });
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
          (err instanceof TypeError || err instanceof Error) &&
          /terminated|fetch failed|ECONNRESET|ETIMEDOUT|EPIPE|UND_ERR_/i.test(message)
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

  // ─── Abstract / overridable ───────────────────────────────────────────────

  /** HTTP endpoint for this provider's chat completions / messages API. */
  protected abstract buildUrl(req: Request): string;

  /** Per-request headers. `apiKey` is already in scope — call `super.buildHeaders` first. */
  /**
   * Last step before a streaming request's body goes on the wire. The base
   * sends the JSON as-is; a wire that may compress sets its own
   * `content-encoding` on `headers` when it does.
   */
  protected encodeRequestBody(json: string, _headers: Record<string, string>): string | Uint8Array {
    return json;
  }

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

  /**
   * Observe the headers of a **successful** response, before the body is read.
   *
   * Called once per request, inside a try/catch — an override may record
   * telemetry or capture routing state but must not assume it can fail loudly.
   * The default implementation does nothing.
   */
  protected onResponseHeaders(_headers: HeadersLike | undefined, _req: Request): void {}

  /** Build a ProviderError from an HTTP failure response. `headers` (when the
   *  fetch impl provides them) lets the parser honour Retry-After hints. */
  protected translateError(status: number, body: string, headers?: HeadersLike): ProviderError {
    return parseProviderHttpError(this.id, status, body, headers);
  }
}
