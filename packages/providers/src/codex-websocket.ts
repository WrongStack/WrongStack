import WebSocket from 'ws';
import type { Request, StreamEvent } from '@wrongstack/core/types';
import { ProviderError } from '@wrongstack/core/types';

/**
 * Response metadata surfaced by a Codex Responses stream.
 *
 * Defined here rather than in `openai-codex.ts` because both transports carry
 * it and `openai-codex.ts` already imports this module: keeping the shape on
 * the provider would make the pair a module cycle. `openai-codex.ts`
 * re-exports it, so the public name is unchanged.
 */
export interface CodexResponseMetadata {
  /** Response metadata headers surfaced by the Responses stream. */
  headers: Readonly<Record<string, string>>;
  /** Provider request id, when the backend supplies one. */
  requestId?: string | undefined;
  /** Server-selected model, when the backend supplies one. */
  model?: string | undefined;
}

export interface CodexWebSocketOptions {
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Never follow redirects on an authenticated WebSocket handshake. */
  followRedirects?: boolean | undefined;
}

export interface CodexWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  removeListener(event: string, listener: (...args: any[]) => void): this;
}

export type CodexWebSocketFactory = (
  url: string,
  options: CodexWebSocketOptions,
) => CodexWebSocketLike;

export type CodexResponsesParser = (
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  providerId: string,
  onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
) => AsyncIterable<StreamEvent>;

export interface CodexWebSocketStreamOptions {
  url: string;
  headers: Record<string, string>;
  request: Request;
  body: Record<string, unknown>;
  fallbackModel: string;
  providerId: string;
  signal: AbortSignal;
  /** Best-effort connection prewarm before the first real response.create. */
  prewarm?: boolean | undefined;
  /**
   * Max silence between WebSocket frames before the turn fails (pre-output
   * failures fall back to SSE). Defaults to `DEFAULT_STALL_TIMEOUT_MS`; `0`
   * disables the watchdog.
   */
  stallTimeoutMs?: number | undefined;
  onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined;
  onHeaders?: ((headers: Headers) => void) | undefined;
}

/** A pre-output WS failure is safe to retry over SSE without duplicate output. */
export class CodexWebSocketFallbackError extends Error {
  override readonly name = 'CodexWebSocketFallbackError';
  constructor(message: string, override readonly cause?: unknown) {
    super(message, { cause });
  }
}

const WS_OPEN = 1;
const MAX_SESSIONS = 64;
/** Frame-to-frame silence budget before a turn is declared stalled. */
const DEFAULT_STALL_TIMEOUT_MS = 30_000;

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

class CodexWebSocketConnection {
  private socket: CodexWebSocketLike | undefined;
  private activeQueue: AsyncQueue<string> | undefined;
  private dead = false;
  private terminalSeen = false;
  private emitted = false;
  private lastResponseId: string | undefined;
  private prewarmed = false;
  // Live abort wiring: kept for the whole turn, not just the handshake, so a
  // mid-stream abort closes the socket and wakes the pending frame wait.
  private abortSignal: AbortSignal | undefined;
  private abortHandler: (() => void) | undefined;

  constructor(
    private readonly factory: CodexWebSocketFactory,
    private readonly url: string,
    private readonly headers: Record<string, string>,
    private readonly onHeaders?: (headers: Headers) => void,
  ) {}

  async *stream(
    body: Record<string, unknown>,
    opts: Pick<
      CodexWebSocketStreamOptions,
      'fallbackModel' | 'providerId' | 'signal' | 'prewarm' | 'onMetadata' | 'stallTimeoutMs'
    >,
    parse: (
      body: ReadableStream<Uint8Array>,
      fallbackModel: string,
      providerId: string,
      onMetadata?: ((metadata: CodexResponseMetadata) => void) | undefined,
    ) => AsyncIterable<StreamEvent>,
  ): AsyncIterable<StreamEvent> {
    await this.open(opts.signal);
    const socket = this.socket;
    if (!socket) throw new CodexWebSocketFallbackError('Codex WebSocket did not open');
    if (opts.prewarm && !this.prewarmed) {
      await this.tryPrewarm(body, opts.signal, socket);
    }
    const queue = new AsyncQueue<string>();
    this.activeQueue = queue;
    this.terminalSeen = false;
    this.emitted = false;

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

    try {
      const requestBody = this.lastResponseId
        ? { ...body, previous_response_id: this.lastResponseId }
        : body;
      socket.send(JSON.stringify({ type: 'response.create', ...requestBody }));
      for await (const event of parse(bodyStream, opts.fallbackModel, opts.providerId, opts.onMetadata)) {
        this.emitted = true;
        yield event;
      }
      if (!this.terminalSeen) {
        throw new CodexWebSocketFallbackError(
          this.emitted
            ? 'Codex WebSocket closed before a terminal response event'
            : 'Codex WebSocket produced no terminal response event',
        );
      }
    } catch (error) {
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
      disarmStall();
      this.activeQueue = undefined;
    }
  }

  close(): void {
    this.dead = true;
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener('abort', this.abortHandler);
      this.abortSignal = undefined;
      this.abortHandler = undefined;
    }
    this.activeQueue?.end(new Error('Codex WebSocket connection closed'));
    this.socket?.close();
    this.socket = undefined;
  }

  private async open(signal: AbortSignal): Promise<void> {
    if (this.dead) throw new CodexWebSocketFallbackError('Codex WebSocket connection is closed');
    if (this.socket?.readyState === WS_OPEN) return;
    this.lastResponseId = undefined;
    this.prewarmed = false;
    // Drop the previous turn's registration before (re)registering so listener
    // wiring never accumulates across turns or sockets.
    if (this.abortSignal && this.abortHandler) {
      this.abortSignal.removeEventListener('abort', this.abortHandler);
    }
    const socket = this.factory(this.url, { headers: this.headers, signal });
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.dead = true;
        reject(error);
      };
      const onAbort = () => {
        socket.close();
        const abortError = signal.reason ?? new Error('Codex WebSocket request aborted');
        // Handshake phase: reject the open promise. Post-open: wake the pending
        // frame wait so stream() fails immediately instead of hanging forever.
        if (!settled) {
          fail(abortError);
          return;
        }
        this.activeQueue?.end(abortError);
      };
      this.abortSignal = signal;
      this.abortHandler = onAbort;
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('open', () => {
        if (settled) return;
        settled = true;
        // The listener deliberately survives the handshake: an abort during the
        // response must close the socket and fail the stream.
        resolve();
      });
      socket.once('error', fail);
      socket.once('unexpected-response', (_request: unknown, response: { headers?: Record<string, string | string[]> }) => {
        if (response.headers) {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers)) {
            if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
          }
          this.onHeaders?.(headers);
        }
        fail(new Error('Codex WebSocket upgrade was rejected'));
      });
    });

    socket.on('message', (data: unknown) => {
      const text = typeof data === 'string' ? data : Buffer.from(data as any).toString('utf8');
      try {
        const event = JSON.parse(text) as { type?: string; response?: { id?: unknown } };
        if (typeof event.response?.id === 'string') this.lastResponseId = event.response.id;
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

  private async tryPrewarm(
    body: Record<string, unknown>,
    signal: AbortSignal,
    socket: CodexWebSocketLike,
  ): Promise<void> {
    const queue = new AsyncQueue<string>();
    this.activeQueue = queue;
    this.terminalSeen = false;
    const timeout = setTimeout(() => queue.end(new Error('Codex WebSocket prewarm timed out')), 3_000);
    try {
      socket.send(JSON.stringify({
        type: 'response.create',
        model: body['model'],
        instructions: body['instructions'] ?? '',
        input: [],
        ...(body['tools'] !== undefined ? { tools: body['tools'] } : {}),
        ...(body['tool_choice'] !== undefined ? { tool_choice: body['tool_choice'] } : {}),
        ...(body['parallel_tool_calls'] !== undefined
          ? { parallel_tool_calls: body['parallel_tool_calls'] }
          : {}),
        ...(body['reasoning'] !== undefined ? { reasoning: body['reasoning'] } : {}),
        store: false,
        stream: true,
        generate: false,
      }));
      while (!this.terminalSeen) {
        const item = await queue.next();
        if (item.done || signal.aborted) break;
        try {
          const event = JSON.parse(item.value) as { type?: string };
          if (event.type === 'response.failed' || event.type === 'error') break;
        } catch {
          // Ignore malformed prewarm frames; the real request remains authoritative.
        }
      }
      this.prewarmed = this.terminalSeen && this.lastResponseId !== undefined;
    } catch {
      // Prewarm is an optimization; the real request remains authoritative.
      this.prewarmed = false;
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

  async *stream(opts: CodexWebSocketStreamOptions, parse: CodexResponsesParser): AsyncIterable<StreamEvent> {
    const key = opts.request.cache?.sessionId ?? '__default__';
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.locks.set(key, chain);
    await previous.catch(() => undefined);
    try {
      let connection = this.connections.get(key);
      if (!connection) {
        connection = new CodexWebSocketConnection(this.factory, opts.url, opts.headers, opts.onHeaders);
        this.connections.set(key, connection);
        while (this.connections.size > this.maxSessions) {
          const oldest = this.connections.keys().next().value;
          if (oldest === undefined || oldest === key) break;
          this.connections.get(oldest)?.close();
          this.connections.delete(oldest);
        }
      }
      try {
        yield* connection.stream(opts.body, opts, parse);
      } catch (error) {
        connection.close();
        this.connections.delete(key);
        throw error;
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
}

export function defaultCodexWebSocketFactory(
  url: string,
  options: CodexWebSocketOptions,
): CodexWebSocketLike {
  return new WebSocket(url, {
    headers: options.headers,
    followRedirects: options.followRedirects ?? false,
    // `ws` accepts an AbortSignal: hand the caller's signal to the transport so
    // a handshake-time abort also tears down the underlying request.
    signal: options.signal,
  });
}
