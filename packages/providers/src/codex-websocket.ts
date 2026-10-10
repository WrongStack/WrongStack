import { isDeepStrictEqual } from 'node:util';
import type { StreamEvent } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';
import {
  CodexWebSocketFallbackError,
  CodexWebSocketRecoveryError,
  type WebSocketRecoveryCode,
  webSocketRecoveryCode,
} from './codex-websocket-recovery.js';
import WebSocket from './ws-runtime.js';

export { CodexWebSocketFallbackError } from './codex-websocket-recovery.js';

import type {
  CodexResponseMetadata,
  CodexResponsesParser,
  CodexWebSocketFactory,
  CodexWebSocketLike,
  CodexWebSocketOptions,
  CodexWebSocketStreamOptions,
} from './codex-websocket-types.js';
import { CODEX_ROUTING_HINT_HEADER } from './openai-codex-request.js';
import { isCacheProbeEnabled, recordCacheProbeTransport } from './prompt-cache-probe.js';
import { responsesReasoningSummary } from './responses-reasoning-summary.js';

export type {
  CodexResponseMetadata,
  CodexResponsesParser,
  CodexWebSocketFactory,
  CodexWebSocketLike,
  CodexWebSocketOptions,
  CodexWebSocketStreamOptions,
} from './codex-websocket-types.js';

function decodeWebSocketMessage(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  if (Array.isArray(data) && data.every(Buffer.isBuffer)) {
    return Buffer.concat(data).toString('utf8');
  }
  throw new TypeError('Unsupported Codex WebSocket message payload');
}

const WS_OPEN = 1;
const MAX_SESSIONS = 64;
/** Frame-to-frame silence budget before a turn is declared stalled. */
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
/**
 * Opening-handshake deadline. The SSE path bounds its header phase at 60s;
 * without this an upgrade request that never gets a reply hung until the OS
 * gave up on the socket, since the frame watchdog only arms after `open`.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

function requestPropertiesMatch(
  previous: Record<string, unknown>,
  current: Record<string, unknown>,
): boolean {
  const { input: _previousInput, ...previousProperties } = previous;
  const { input: _currentInput, ...currentProperties } = current;
  return isDeepStrictEqual(previousProperties, currentProperties);
}

/**
 * Convert a server output item to the stateless replay shape emitted by
 * `messagesToResponsesInput`. Server-only item ids/status fields must not make
 * an otherwise identical conversation look different.
 */
function replayableResponseItem(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (item.type === 'reasoning') {
    return typeof item.id === 'string' && typeof item.encrypted_content === 'string'
      ? {
          type: 'reasoning',
          id: item.id,
          encrypted_content: item.encrypted_content,
          summary: responsesReasoningSummary(item.summary),
        }
      : undefined;
  }
  if (item.type === 'function_call') {
    return typeof item.call_id === 'string' && typeof item.name === 'string'
      ? {
          type: 'function_call',
          call_id: item.call_id,
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '',
        }
      : undefined;
  }
  if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
    const content = item.content.flatMap((part) => {
      if (!part || typeof part !== 'object') return [];
      const block = part as Record<string, unknown>;
      if (block.type === 'output_text' && typeof block.text === 'string') {
        return [{ type: 'output_text', text: block.text, annotations: [] }];
      }
      if (block.type === 'refusal' && typeof block.refusal === 'string') {
        return [{ type: 'output_text', text: block.refusal, annotations: [] }];
      }
      return [];
    });
    return content.length > 0
      ? { type: 'message', role: 'assistant', content, status: 'completed' }
      : undefined;
  }
  return undefined;
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private ended = false;
  private error: unknown;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
  }

  end(error?: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ done: true, value: undefined as never });
    }
  }

  next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.ended) {
      return this.error
        ? Promise.reject(this.error)
        : Promise.resolve({ done: true, value: undefined as never });
    }
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

type CodexWebSocketTurnOptions = Omit<
  CodexWebSocketStreamOptions,
  'url' | 'headers' | 'body' | 'onHeaders'
> & {
  recoveryReason?: WebSocketRecoveryCode | undefined;
};

class CodexWebSocketConnection {
  private socket: CodexWebSocketLike | undefined;
  private activeQueue: AsyncQueue<string> | undefined;
  private dead = false;
  private terminalSeen = false;
  private emitted = false;
  private lastResponseId: string | undefined;
  private currentResponseId: string | undefined;
  private lastRequestBody: Record<string, unknown> | undefined;
  private pendingRequestBody: Record<string, unknown> | undefined;
  private lastResponseItems: Record<string, unknown>[] = [];
  private pendingResponseItems: Record<string, unknown>[] = [];
  /** Turn state for the in-flight request, supplied per call by the caller. */
  private turnState: string | undefined;
  private onTurnState: ((turnState: string) => void) | undefined;
  private prewarmed = false;
  /** Close as soon as the in-flight request settles (token rotation, eviction). */
  private retireWhenIdle = false;
  /** A request owns this connection, from handshake through its last frame. */
  private inFlight = false;

  constructor(
    private readonly factory: CodexWebSocketFactory,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onHeaders?: (headers: Headers) => void,
  ) {}

  /** The routing hint this connection's handshake carried. */
  get routingHint(): string | undefined {
    return this.headers[CODEX_ROUTING_HINT_HEADER];
  }

  async *stream(
    body: Record<string, unknown>,
    opts: CodexWebSocketTurnOptions,
    parse: (
      body: ReadableStream<Uint8Array>,
      fallbackModel: string,
      providerId: string,
      onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
    ) => AsyncIterable<StreamEvent>,
  ): AsyncIterable<StreamEvent> {
    this.inFlight = true;
    try {
      yield* this.streamInner(body, opts, parse);
    } finally {
      this.inFlight = false;
      if (this.retireWhenIdle) this.close();
    }
  }

  private async *streamInner(
    body: Record<string, unknown>,
    opts: CodexWebSocketTurnOptions,
    parse: (
      body: ReadableStream<Uint8Array>,
      fallbackModel: string,
      providerId: string,
      onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
    ) => AsyncIterable<StreamEvent>,
  ): AsyncIterable<StreamEvent> {
    // Turn scoping is the caller's call: it knows whether this request
    // continues the turn in flight or opens a new one.
    this.turnState = opts.turnState;
    this.onTurnState = opts.onTurnState;
    try {
      await this.open(opts.signal);
    } catch (error) {
      if (opts.signal.aborted) throw opts.signal.reason ?? error;
      // A handshake rejected with 401 means the bearer went stale: surface it
      // as the ProviderError the caller refreshes on. Every other handshake
      // failure (upgrade refused, DNS, reset, timeout) happened before any
      // output, so it is exactly the case the SSE fallback exists for — as a
      // plain Error it neither fell back nor refreshed, and failed every turn.
      const status = (error as { status?: unknown }).status;
      if (status === 401) {
        throw new ProviderError(
          'Codex WebSocket upgrade unauthorized',
          401,
          false,
          opts.providerId,
          {
            cause: error,
            body: { message: 'Codex WebSocket upgrade unauthorized' },
          },
        );
      }
      if (error instanceof CodexWebSocketFallbackError) throw error;
      throw new CodexWebSocketFallbackError('Codex WebSocket handshake failed', error);
    }
    const socket = this.socket;
    if (!socket) throw new CodexWebSocketFallbackError('Codex WebSocket did not open');
    const queue = new AsyncQueue<string>();
    this.activeQueue = queue;
    this.emitted = false;
    // The pool can reuse an already-open socket. Bind cancellation to this
    // stream—not socket creation—so every request can terminate its own wait.
    const abort = (): unknown => opts.signal.reason ?? new Error('Codex WebSocket request aborted');
    const onAbort = () => {
      queue.end(abort());
      socket.close();
    };
    if (opts.signal.aborted) {
      onAbort();
      throw abort();
    }
    opts.signal.addEventListener('abort', onAbort, { once: true });

    // Frame-gap watchdog: a backend that goes silent without closing the socket
    // must fail the turn (falling back to SSE pre-output) instead of hanging
    // the stream — and the whole process — forever.
    const stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = (): void => {
      if (stallTimeoutMs <= 0) return;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () => queue.end(new Error(`Codex WebSocket stalled: no frame for ${stallTimeoutMs}ms`)),
        stallTimeoutMs,
      );
    };
    const disarmStall = (): void => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer);
        stallTimer = undefined;
      }
    };

    let usedContinuation = false;
    try {
      if (opts.prewarm && !this.prewarmed) {
        await this.tryPrewarm(body, opts.signal, socket);
        this.activeQueue = queue;
      }
      if (opts.signal.aborted) throw abort();
      // ReadableStream pulls eagerly; create it only once prewarm has ended.
      const bodyStream = new ReadableStream<Uint8Array>({
        pull: async (controller) => {
          try {
            armStall();
            const item = await queue.next();
            disarmStall();
            if (item.done) controller.close();
            else controller.enqueue(new TextEncoder().encode(`data: ${item.value}\n\n`));
          } catch (error) {
            disarmStall();
            controller.error(error);
          }
        },
        cancel: () => {
          disarmStall();
          queue.end();
        },
      });
      const prepared = this.prepareRequestBody(body);
      const requestBody = prepared.body;
      usedContinuation = typeof requestBody.previous_response_id === 'string';
      if (isCacheProbeEnabled()) {
        recordCacheProbeTransport({
          provider: opts.providerId,
          sessionKey: String(body.prompt_cache_key ?? 'no-session'),
          threadId: opts.request.cache?.threadId ?? opts.request.cache?.sessionId,
          requestId: opts.probeRequestId,
          model: opts.request.model,
          mode: requestBody.previous_response_id ? 'delta' : 'full',
          reason: opts.recoveryReason ? `reconnect:${opts.recoveryReason}` : prepared.reason,
          fullInputItems: Array.isArray(body.input) ? body.input.length : 0,
          sentInputItems: Array.isArray(requestBody.input) ? requestBody.input.length : 0,
        });
      }
      this.beginResponse(body);
      socket.send(JSON.stringify({ type: 'response.create', ...requestBody }));
      for await (const event of parse(
        bodyStream,
        opts.fallbackModel,
        opts.providerId,
        opts.onMetadata,
      )) {
        if (event.type !== 'message_start') this.emitted = true;
        yield event;
      }
      if (!this.terminalSeen) {
        throw new CodexWebSocketFallbackError(
          this.emitted
            ? 'Codex WebSocket closed before a terminal response event'
            : 'Codex WebSocket produced no terminal response event',
        );
      }
      this.commitResponse();
    } catch (error) {
      if (opts.signal.aborted) throw abort();
      if (error instanceof ProviderError && !this.emitted) {
        const code = webSocketRecoveryCode(error);
        if (code)
          throw new CodexWebSocketRecoveryError(
            code,
            error,
            code === 'websocket_connection_limit_reached' || usedContinuation,
          );
      }
      if (error instanceof CodexWebSocketFallbackError && this.emitted) {
        throw new ProviderError(error.message, 0, true, opts.providerId, {
          cause: error.cause ?? error,
          body: { message: error.message },
        });
      }
      if (error instanceof ProviderError) throw error;
      if (this.emitted) {
        throw new ProviderError(String(error), 0, true, opts.providerId, {
          cause: error,
          body: { message: String(error) },
        });
      }
      throw new CodexWebSocketFallbackError('Codex WebSocket request failed before output', error);
    } finally {
      opts.signal.removeEventListener('abort', onAbort);
      disarmStall();
      this.activeQueue = undefined;
      this.onTurnState = undefined;
    }
  }

  /**
   * Stop reusing this connection without killing the request it is serving:
   * close now when idle, otherwise once the in-flight stream settles. A token
   * refresh triggered by one session used to end every other session's live
   * response with "connection closed" (and, pre-output, permanently disable
   * WebSocket for the process).
   */
  retire(): void {
    if (this.inFlight) this.retireWhenIdle = true;
    else this.close();
  }

  close(): void {
    this.dead = true;
    this.activeQueue?.end(new Error('Codex WebSocket connection closed'));
    this.socket?.close();
    this.socket = undefined;
  }

  private async open(signal: AbortSignal): Promise<void> {
    if (this.dead) throw new CodexWebSocketFallbackError('Codex WebSocket connection is closed');
    if (this.socket?.readyState === WS_OPEN) return;
    this.lastResponseId = undefined;
    this.currentResponseId = undefined;
    this.lastRequestBody = undefined;
    this.pendingRequestBody = undefined;
    this.lastResponseItems = [];
    this.pendingResponseItems = [];
    this.prewarmed = false;
    const socket = this.factory(this.url, { headers: this.headers, signal });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let clearAbortListener: () => void = () => undefined;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearAbortListener();
        this.dead = true;
        reject(error);
      };
      const onAbort = () => {
        socket.close();
        fail(signal.reason ?? new Error('Codex WebSocket request aborted'));
      };
      clearAbortListener = () => signal.removeEventListener('abort', onAbort);
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('open', () => {
        if (settled) return;
        settled = true;
        clearAbortListener();
        resolve();
      });
      socket.once('error', fail);
      socket.once(
        'unexpected-response',
        (
          _request: unknown,
          response: { statusCode?: number; headers?: Record<string, string | string[]> },
        ) => {
          if (response.headers) {
            const headers = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined)
                headers.set(name, Array.isArray(value) ? value.join(', ') : value);
            }
            this.onHeaders?.(headers);
          }
          fail(
            Object.assign(
              new Error(
                `Codex WebSocket upgrade was rejected${response.statusCode ? ` (HTTP ${response.statusCode})` : ''}`,
              ),
              { status: response.statusCode },
            ),
          );
        },
      );
    });

    socket.on('message', (data: unknown) => {
      const text = decodeWebSocketMessage(data);
      try {
        const event = JSON.parse(text) as {
          type?: string;
          item?: unknown;
          headers?: Record<string, unknown>;
          metadata?: { headers?: Record<string, unknown> };
          response?: { id?: unknown; output?: unknown };
        };
        if (typeof event.response?.id === 'string') this.currentResponseId = event.response.id;
        if (event.type === 'response.output_item.done') {
          const replayable = replayableResponseItem(event.item);
          if (replayable) this.pendingResponseItems.push(replayable);
        }
        if (
          (event.type === 'response.completed' || event.type === 'response.done') &&
          this.pendingResponseItems.length === 0 &&
          Array.isArray(event.response?.output)
        ) {
          for (const output of event.response.output) {
            const replayable = replayableResponseItem(output);
            if (replayable) this.pendingResponseItems.push(replayable);
          }
        }
        // The live backend names this frame `codex.response.metadata` and puts
        // the headers at the top level; the enveloped `response.metadata` shape
        // is the other dialect upstream also accepts. Reading only the envelope
        // meant a WebSocket session — the default transport, with no HTTP
        // headers after the handshake — never saw its own turn state.
        if (event.type === 'response.metadata' || event.type === 'codex.response.metadata') {
          for (const [name, value] of Object.entries(
            event.headers ?? event.metadata?.headers ?? {},
          )) {
            if (name.toLowerCase() === 'x-codex-turn-state' && typeof value === 'string') {
              // Usable both later in this turn (the next request the caller
              // makes) and, via the sink, by whoever owns turn scoping.
              this.turnState = value;
              this.onTurnState?.(value);
            }
          }
        }
        if (
          event.type === 'response.completed' ||
          event.type === 'response.incomplete' ||
          event.type === 'response.done'
        ) {
          this.terminalSeen = true;
        }
      } catch {
        // The shared Responses parser will ignore malformed frames.
      }
      const queue = this.activeQueue;
      queue?.push(text);
      if (this.terminalSeen) queue?.end();
    });
    socket.on('error', (error: unknown) => this.activeQueue?.end(error));
    socket.on('close', () => this.activeQueue?.end());
  }

  private beginResponse(fullRequestBody: Record<string, unknown>): void {
    this.terminalSeen = false;
    this.currentResponseId = undefined;
    this.pendingRequestBody = fullRequestBody;
    this.pendingResponseItems = [];
  }

  private commitResponse(): void {
    if (!this.currentResponseId || !this.pendingRequestBody) return;
    this.lastResponseId = this.currentResponseId;
    this.lastRequestBody = this.pendingRequestBody;
    this.lastResponseItems = this.pendingResponseItems;
    // A generated response also warms the connection, including recovery
    // requests that deliberately skip a separate generate=false round trip.
    this.prewarmed = true;
  }

  /**
   * Reuse `previous_response_id` only when the current request is a genuine
   * extension of the exact full request + server output that produced it.
   * Otherwise send the full request without a stale response id.
   */
  private prepareRequestBody(body: Record<string, unknown>): {
    body: Record<string, unknown>;
    reason: string;
  } {
    // Turn state is sticky routing, not a continuation detail: it belongs on
    // every request of the turn, including the ones that resend the full input.
    const withTurnState = this.turnState
      ? { ...body, client_metadata: { 'x-codex-turn-state': this.turnState } }
      : body;
    const full = (reason: string) => ({ body: withTurnState, reason });
    if (!this.lastResponseId || !this.lastRequestBody) return full('no-previous-response');
    if (!requestPropertiesMatch(this.lastRequestBody, body))
      return full('request-settings-changed');
    const previousInput = this.lastRequestBody.input;
    const currentInput = body.input;
    if (!Array.isArray(previousInput) || !Array.isArray(currentInput))
      return full('non-array-input');
    const baseline = [...previousInput, ...this.lastResponseItems];
    if (currentInput.length < baseline.length) return full('history-shortened');
    for (let index = 0; index < baseline.length; index++) {
      if (!isDeepStrictEqual(baseline[index], currentInput[index])) return full('history-changed');
    }
    return {
      reason: 'prefix-match',
      body: {
        ...withTurnState,
        previous_response_id: this.lastResponseId,
        input: currentInput.slice(baseline.length),
      },
    };
  }

  /**
   * V2 prewarm sends the real request with `generate=false`, then the real
   * inference references that response and sends an empty incremental delta.
   * This is the current openai/codex protocol; an empty standalone request is
   * invalid, while replaying the full input alongside the response id duplicates
   * context.
   */
  private async tryPrewarm(
    body: Record<string, unknown>,
    signal: AbortSignal,
    socket: CodexWebSocketLike,
  ): Promise<void> {
    if (!Array.isArray(body.input) || body.input.length === 0) {
      this.prewarmed = true;
      return;
    }
    const queue = new AsyncQueue<string>();
    this.activeQueue = queue;
    this.beginResponse(body);
    const timeout = setTimeout(
      () => queue.end(new Error('Codex WebSocket prewarm timed out')),
      3_000,
    );
    try {
      socket.send(JSON.stringify({ type: 'response.create', ...body, generate: false }));
      // Frames can arrive in one batch. The listener's terminalSeen flag may
      // already be set before this consumer reads the failure/completion frame.
      let completed = false;
      while (!completed) {
        const item = await queue.next();
        if (item.done || signal.aborted) break;
        const event = JSON.parse(item.value) as { type?: string; response?: { status?: string } };
        const terminal = event.type === 'response.completed' || event.type === 'response.done';
        if (
          event.type === 'response.failed' ||
          event.type === 'error' ||
          event.type === 'response.incomplete' ||
          (terminal &&
            event.response?.status !== undefined &&
            event.response.status !== 'completed')
        ) {
          throw new Error('Codex WebSocket prewarm was rejected');
        }
        completed = terminal;
      }
      if (signal.aborted) throw signal.reason ?? new Error('Codex WebSocket prewarm aborted');
      if (!completed || !this.currentResponseId) {
        throw new Error('Codex WebSocket prewarm produced no reusable response');
      }
      this.commitResponse();
      this.prewarmed = true;
    } catch (error) {
      this.prewarmed = false;
      throw new CodexWebSocketFallbackError('Codex WebSocket prewarm failed', error);
    } finally {
      clearTimeout(timeout);
      this.activeQueue = undefined;
    }
  }
}

/**
 * Bounded, per-session WebSocket reuse. A session has one in-flight request at
 * a time; later requests queue behind it so frames cannot cross conversations.
 */
export class CodexWebSocketPool {
  private readonly connections = new Map<string, CodexWebSocketConnection>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly factory: CodexWebSocketFactory,
    private readonly maxSessions = MAX_SESSIONS,
  ) {}

  async *stream(
    opts: CodexWebSocketStreamOptions,
    parse: CodexResponsesParser,
  ): AsyncIterable<StreamEvent> {
    const key = opts.request.cache?.threadId ?? opts.request.cache?.sessionId ?? '__default__';
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, chain);
    await previous.catch(() => undefined);
    try {
      let recoveryReason: WebSocketRecoveryCode | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (opts.signal.aborted)
          throw opts.signal.reason ?? new Error('Codex WebSocket request aborted');
        let connection = this.connections.get(key);
        // Handshake headers are fixed for a connection's life, so a session
        // that switched model would keep routing by the old one. The switch
        // already costs the cached prefix; a fresh handshake costs nothing more.
        if (connection && connection.routingHint !== opts.headers[CODEX_ROUTING_HINT_HEADER]) {
          connection.close();
          this.connections.delete(key);
          connection = undefined;
        }
        if (!connection) {
          connection = new CodexWebSocketConnection(
            this.factory,
            opts.url,
            opts.headers,
            opts.onHeaders,
          );
          this.connections.set(key, connection);
          while (this.connections.size > this.maxSessions) {
            const oldest = this.connections.keys().next().value;
            if (oldest === undefined || oldest === key) break;
            // Eviction must not cut another session's live response.
            this.connections.get(oldest)?.retire();
            this.connections.delete(oldest);
          }
        }
        try {
          yield* connection.stream(
            opts.body,
            recoveryReason ? { ...opts, prewarm: false, recoveryReason } : opts,
            parse,
          );
          return;
        } catch (error) {
          connection.close();
          if (this.connections.get(key) === connection) this.connections.delete(key);
          if (
            attempt === 0 &&
            error instanceof CodexWebSocketRecoveryError &&
            error.canReconnect &&
            !opts.signal.aborted
          ) {
            recoveryReason = error.code;
            continue;
          }
          throw error;
        }
      }
    } finally {
      release();
      if (this.locks.get(key) === chain) this.locks.delete(key);
    }
  }

  close(): void {
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
    this.locks.clear();
  }

  /**
   * Drop every pooled connection from reuse (e.g. after token rotation, whose
   * old bearer they captured at handshake) while letting in-flight responses
   * finish. Per-key locks are kept, so a queued request still waits its turn
   * and then opens a fresh socket.
   */
  retireAll(): void {
    for (const connection of this.connections.values()) connection.retire();
    this.connections.clear();
  }
}

export function defaultCodexWebSocketFactory(
  url: string,
  options: CodexWebSocketOptions,
): CodexWebSocketLike {
  return new WebSocket(url, {
    headers: options.headers,
    followRedirects: options.followRedirects ?? false,
    handshakeTimeout: options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    // `ws` accepts an AbortSignal: hand the caller's signal to the transport so
    // a handshake-time abort also tears down the underlying request.
    signal: options.signal,
  }) as CodexWebSocketLike;
}
