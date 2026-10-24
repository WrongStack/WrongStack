import { randomBytes } from 'node:crypto';
import { ToolError } from '@wrongstack/contracts/types';
import { assertSupportedServerProtocolVersion, MCP_CONSTANTS } from './constants.js';
import type { JsonRpcResponse, ToolCallResult } from './contracts.js';
import {
  logMessageNotification,
  parseServerMetadata,
  progressNotification,
  resourceUpdatedUri,
} from './protocol.js';
import { readBodyCapped } from './read-body.js';
import { SSEReader } from './sse-reader.js';
import { listAllTools, toToolCallResult } from './tool-schema.js';
import {
  BaseHTTPTransport,
  type HttpTransportOptions,
  makeAbortError,
  nextJsonRpcId,
} from './transport-base.js';
import {
  assertMatchingJsonRpcResult,
  encodeJsonRpcMessage,
  isJsonRpcResult,
  type JsonRpcResult,
} from './transport-jsonrpc.js';
import { validateTransportUrl } from './transport-security.js';

/**
 * Longest connect() waits for the legacy `endpoint` event before POSTing to
 * the configured URL. The wait also ends on the first dispatched event and on
 * stream end, so servers that never send one cost at most this much.
 */
const ENDPOINT_WAIT_MS = 1_000;

/**
 * HTTP statuses that mean the session itself is gone. Only these tear the
 * connection down from the request path; a 5xx or a single slow call is a call
 * error, not a dead session (the stream closing is what signals that).
 */
const SESSION_FATAL_HTTP_STATUSES = new Set([401, 403, 404, 410]);

interface StreamPending {
  resolve: (result: JsonRpcResult) => void;
  reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// SSE Transport
// ---------------------------------------------------------------------------

/**
 * SSE transport for MCP over HTTP (the 2024-11-05 "HTTP with SSE" transport).
 *
 * The client opens a GET event stream. A compliant server first sends
 * `event: endpoint` naming the URL to POST JSON-RPC to, answers each POST with
 * `202 Accepted`, and delivers the response over the stream. Servers that
 * answer in the POST body instead are also supported: a JSON body is taken as
 * the response, an empty/202 body waits for the stream.
 */
export class SSETransport extends BaseHTTPTransport {
  private _nextId = 1;
  private readerDone = false;
  private closed = false;
  private toolCatalogVersion = 0;
  private toolCatalogRevision = 0;
  private readLoopAbort?: AbortController | undefined;
  private reader?: globalThis.ReadableStreamDefaultReader<string> | undefined;
  /** POST target announced by the server's `endpoint` event. */
  private endpointUrl?: string | undefined;
  /** Wakes connect() once the endpoint is known (or will not arrive). */
  private streamSignal?: (() => void) | undefined;
  /** Requests whose response is expected over the event stream, keyed by id. */
  private readonly streamPending = new Map<number, StreamPending>();

  constructor(opts: HttpTransportOptions) {
    super(opts, 'SSETransport');
  }

  protected override genId(): number {
    const id = this._nextId;
    this._nextId = nextJsonRpcId(id);
    return id;
  }

  /** Refresh tool list when server sends notifications/tools/list_changed. */
  private async handleToolsListChanged(): Promise<void> {
    const version = ++this.toolCatalogVersion;
    try {
      const tools = await listAllTools((params) => this.httpPost('tools/list', params));
      // A failed refresh keeps the last known catalog instead of wiping it.
      if (!tools || version !== this.toolCatalogVersion) return;
      this.tools.splice(0, this.tools.length, ...tools);
      this.toolCatalogRevision++;
      for (const cb of this.toolsChangedListeners) {
        if (version !== this.toolCatalogVersion) break;
        try {
          cb([...this.tools]);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore transient failures */
    }
  }

  async connect(): Promise<void> {
    this.toolCatalogVersion++;
    this.readerDone = false;
    this.closed = false;
    this.endpointUrl = undefined;
    this.state = 'connecting';
    this.serverMetadata = undefined;
    const controller = new AbortController();
    this.abortController = controller;
    const signal = controller.signal;
    const assertCurrent = (): void => {
      if (this.abortController !== controller || signal.aborted || this.closed) {
        throw makeAbortError('connect');
      }
    };
    const startupTimer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const sseUrl = this.buildSSEUrl();
      const fetchOpts: RequestInit = {
        headers: { Accept: 'text/event-stream', ...this.headers },
        signal,
      };
      this.applyTlsAgent(fetchOpts);
      const response = await this.fetchWithAuthorization(sseUrl, fetchOpts, signal);
      try {
        assertCurrent();
      } catch (error) {
        await response.body?.cancel().catch(() => undefined);
        throw error;
      }

      if (!response.ok) {
        throw new ToolError({
          message: `SSE connect HTTP ${response.status}: ${response.statusText}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_sse_connect',
          context: { url: sseUrl, status: response.status, statusText: response.statusText },
        });
      }

      if (!response.body) {
        throw new ToolError({
          message: 'SSE response has no body',
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_sse_connect',
          context: { url: sseUrl, reason: 'missing-body' },
        });
      }

      const textDecoder = new TextDecoder();
      const sseReader = new SSEReader();
      const readLoopAbort = new AbortController();
      this.readLoopAbort = readLoopAbort;
      const streamReady = new Promise<void>((resolve) => {
        this.streamSignal = resolve;
      });

      sseReader.onEndpoint((endpoint) => {
        if (this.abortController !== controller || signal.aborted || this.closed) return;
        this.acceptEndpoint(endpoint);
        this.streamSignal?.();
      });
      sseReader.onMessage((msg) => {
        if (this.abortController !== controller || signal.aborted || this.closed) return;
        this.streamSignal?.();
        // A server request (method + id), e.g. elicitation: answered by POST.
        const id: unknown = msg.id;
        if (msg.method && (typeof id === 'number' || typeof id === 'string')) {
          void this.replyToServer(
            { id, method: msg.method, params: msg.params },
            this.endpointUrl ?? this.url,
            this.headers,
          );
          return;
        }
        // Server-initiated notifications (no id). Handle list_changed for L2-C.
        if (msg.method) {
          if (msg.method === 'notifications/cancelled') {
            this.serverRequests.cancel(msg.params);
          } else if (msg.method === 'notifications/tools/list_changed') {
            void this.handleToolsListChanged();
          } else if (msg.method === 'notifications/resources/list_changed') {
            this.notifyResourcesChanged();
          } else if (msg.method === 'notifications/prompts/list_changed') {
            this.notifyPromptsChanged();
          } else if (msg.method === 'notifications/resources/updated') {
            const uri = resourceUpdatedUri(msg.params);
            if (uri) this.notifyResourceUpdated(uri);
          } else if (msg.method === 'notifications/progress') {
            const progress = progressNotification(msg.params);
            if (progress) this.notifyProgress(progress);
          } else if (msg.method === 'notifications/message') {
            const log = logMessageNotification(msg.params);
            if (log) this.notifyLogMessage(log);
          }
          return;
        }
        // A response delivered over the stream (the spec-compliant path).
        if (!msg.method && isJsonRpcResult(msg)) {
          const pending = this.streamPending.get(msg.id);
          if (pending) {
            this.streamPending.delete(msg.id);
            pending.resolve(msg);
          }
        }
      });

      const reader = response.body.getReader();
      this.reader = {
        cancel: () => reader.cancel(),
        releaseLock: () => reader.releaseLock(),
      } as globalThis.ReadableStreamDefaultReader<string>;

      void this.readSSEBody(reader, textDecoder, sseReader, controller, readLoopAbort.signal);
      await this.waitForStream(streamReady, signal);
      assertCurrent();

      const initRes = await this.httpPost('initialize', {
        protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
        // Client capabilities: elicitation when the host can ask its user.
        // `tools` is a SERVER capability and never belonged here.
        capabilities: this.serverRequests.capabilities(),
        clientInfo: MCP_CONSTANTS.CLIENT_INFO,
      });
      assertCurrent();

      if (initRes.error) {
        throw new ToolError({
          message: `initialize failed: ${initRes.error.message}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_initialize',
          context: { transport: 'sse', url: this.url },
        });
      }
      this.serverMetadata = parseServerMetadata(initRes.result);
      // Throws on a revision we do not implement; the catch below aborts the
      // connect controller and the MCPClient connect wrapper closes down.
      this.protocolVersion = assertSupportedServerProtocolVersion(
        this.name,
        this.serverMetadata.protocolVersion,
      );

      try {
        await this.httpPost('notifications/initialized', {});
      } catch {
        // servers may not require it
      }
      assertCurrent();

      const revision = this.toolCatalogRevision;
      const tools = await listAllTools((params) => this.httpPost('tools/list', params));
      assertCurrent();
      if (revision === this.toolCatalogRevision) {
        this.tools.splice(0, this.tools.length, ...(tools ?? []));
      }

      this.state = 'connected';
      clearTimeout(startupTimer);
    } catch (err) {
      clearTimeout(startupTimer);
      if (this.abortController === controller && !this.closed) {
        this.state = 'failed';
      }
      controller.abort();
      throw err;
    } finally {
      if (this.abortController === controller) this.streamSignal = undefined;
    }
  }

  /** Resolve once the stream announced its endpoint, emitted anything, ended, or the cap passed. */
  private async waitForStream(ready: Promise<void>, signal: AbortSignal): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.min(ENDPOINT_WAIT_MS, this.timeout));
          timer.unref?.();
        }),
        new Promise<void>((resolve) => {
          onAbort = resolve;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Adopt the server's POST endpoint. It must stay on the configured origin:
   * a cross-origin endpoint would move every request — Authorization header
   * included — to a host that never passed configuration review.
   */
  private acceptEndpoint(endpoint: string): void {
    try {
      const next = new URL(endpoint, this.url);
      if (next.origin !== new URL(this.url).origin) return;
      validateTransportUrl(next.toString());
      this.endpointUrl = next.toString();
    } catch {
      /* malformed endpoint — keep POSTing to the configured URL */
    }
  }

  private async readSSEBody(
    reader: globalThis.ReadableStreamDefaultReader<Uint8Array>,
    decoder: InstanceType<typeof TextDecoder>,
    sseReader: SSEReader,
    controller?: AbortController,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      while (
        !this.readerDone &&
        !signal?.aborted &&
        (!controller || this.abortController === controller) &&
        !this.closed
      ) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        sseReader.feed(chunk);
      }
    } catch {
      // SSE read error — connection lost.
    } finally {
      if (!controller || this.abortController === controller) {
        this.streamSignal?.();
        // Responses that were to arrive over this stream never will.
        this.rejectStreamPending('SSE stream closed');
        // Stream ended (either via error or clean remote close / EOF).
        // Transition to disconnected so callTool and health checks see
        // the correct state, then notify disconnect handlers so the
        // registry can schedule a reconnect.
        if (
          !this.readerDone &&
          !signal?.aborted &&
          !this.closed &&
          this.state !== 'disconnected' &&
          this.state !== 'failed'
        ) {
          this.state = 'disconnected';
          this.notifyDisconnect();
        }
      }
    }
  }

  private rejectStreamPending(reason: string): void {
    if (this.streamPending.size === 0) return;
    const err = new Error(`MCP "${this.name}": ${reason}`);
    const pending = [...this.streamPending.values()];
    this.streamPending.clear();
    for (const entry of pending) entry.reject(err);
  }

  private buildSSEUrl(): string {
    try {
      const url = new URL(this.url);
      // Cryptographically random session ID instead of timestamp —
      // prevents an attacker on the same LAN from guessing the session
      // param and reconnecting to the SSE stream.
      url.searchParams.set('session', randomBytes(16).toString('hex'));
      return url.toString();
    } catch {
      return this.url;
    }
  }

  /** Register interest in a stream-delivered response before the POST goes out. */
  private awaitStreamResponse(id: number, signal: AbortSignal): Promise<JsonRpcResult> {
    const promise = new Promise<JsonRpcResult>((resolve, reject) => {
      const onAbort = () =>
        reject(signal.reason instanceof Error ? signal.reason : new Error('MCP request aborted'));
      this.streamPending.set(id, {
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        reject: (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      });
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    // Unobserved whenever the POST body carries the response directly.
    promise.catch(() => undefined);
    return promise;
  }

  private httpPost(
    method: string,
    params: unknown,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JsonRpcResult> {
    return this.postJsonRpc(method, params, this.requestTimeout, opts);
  }

  private async postJsonRpc(
    method: string,
    params: unknown,
    timeoutMs: number,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JsonRpcResult> {
    const id = this.genId();
    const isNotification = method.startsWith('notifications/');
    const body = encodeJsonRpcMessage(id, method, params);

    const external = opts?.signal;
    const parent =
      external && this.abortController
        ? AbortSignal.any([this.abortController.signal, external])
        : (external ?? this.abortController?.signal);
    const timeoutSignal = this.requestTimeoutSignal(parent, timeoutMs);
    const streamed = isNotification
      ? undefined
      : this.awaitStreamResponse(id, timeoutSignal.signal);
    const fetchOpts: RequestInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.headers,
      },
      body,
      signal: timeoutSignal.signal,
    };
    this.applyTlsAgent(fetchOpts);
    // fetch lives INSIDE the try so dispose() runs on every exit path — a
    // rejected fetch must not leak the timeout timer / abort listener.
    try {
      let res: Response;
      try {
        res = await this.fetchWithAuthorization(
          this.endpointUrl ?? this.url,
          fetchOpts,
          timeoutSignal.signal,
        );
      } catch (err) {
        // The request never reached the server (connection refused/reset):
        // the session is gone. A timeout or caller abort is NOT — one slow
        // tool call used to tear down every other call on the session.
        if (!timeoutSignal.signal.aborted) this.markDisconnected();
        throw err;
      }
      if (!res.ok) {
        if (SESSION_FATAL_HTTP_STATUSES.has(res.status)) this.markDisconnected();
        // Cap the body — a misbehaving server could return megabytes of
        // HTML and that's not useful in an error message anyway. readBodyCapped
        // bounds the BUFFER; when even the cap is exceeded we keep the
        // status-line error and drop the snippet.
        let snippet: string;
        try {
          snippet = await readBodyCapped(res, MCP_CONSTANTS.REQUEST_LOG_CAP);
        } catch (err) {
          const received =
            err instanceof ToolError && typeof err.context?.['received'] === 'number'
              ? err.context['received']
              : undefined;
          snippet =
            typeof received === 'number'
              ? `… [${received}+ bytes total]`
              : '… [error body unreadable]';
        }
        throw new ToolError({
          message: `HTTP ${res.status}: ${snippet}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: method,
          context: { transport: 'sse', url: this.url, status: res.status },
        });
      }

      // Notifications get no JSON-RPC reply (the server returns 202 / empty body).
      if (isNotification || !streamed) {
        await readBodyCapped(res).catch(() => undefined);
        return { jsonrpc: '2.0', id };
      }

      let text: string;
      try {
        text = await readBodyCapped(res);
      } catch (err) {
        throw invalidResponse(method, this.url, err);
      }
      // Spec-compliant server: 202 Accepted, response arrives on the stream.
      if (res.status === 202 || text.trim() === '') {
        return await streamed;
      }
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch (err) {
        throw invalidResponse(method, this.url, err);
      }
      return assertMatchingJsonRpcResult(data, id, method);
    } catch (err) {
      if (external?.aborted && !isNotification) {
        // MCP spec cancellation: tell the server to stop the in-flight
        // request. Best-effort fire-and-forget — the caller is already
        // unwinding on the abort.
        void this.httpPost('notifications/cancelled', {
          requestId: id,
          reason: 'client aborted',
        }).catch(() => {});
        throw makeAbortError(method);
      }
      throw err;
    } finally {
      const pending = this.streamPending.get(id);
      if (pending) {
        this.streamPending.delete(id);
        pending.reject(new Error('MCP request settled'));
      }
      timeoutSignal.dispose();
    }
  }

  async callTool(
    name: string,
    input: unknown,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new ToolError({
        message: `SSE transport not connected (state=${this.state})`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: name,
        context: { transport: 'sse', state: this.state },
      });
    }
    // The progressToken opts the call into `notifications/progress` while it
    // runs (2024-11-05 progress utility) — a server MAY answer with progress
    // notifications carrying this token.
    const res = await this.httpPost(
      'tools/call',
      { name, arguments: input, _meta: { progressToken: this.nextProgressToken() } },
      opts,
    );
    return toToolCallResult(res);
  }

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE transports. */
  async request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JsonRpcResponse> {
    const result = await this.postJsonRpc(method, params, timeoutMs ?? this.requestTimeout, opts);
    return { jsonrpc: '2.0', id: result.id, result: result.result, error: result.error };
  }

  async close(): Promise<void> {
    this.toolCatalogVersion++;
    this.releasePinnedDispatcher();
    // Idempotent. Keyed on `closed`, not on state: a stream that already
    // dropped leaves the state 'disconnected' but its in-flight requests,
    // abort controller and handlers still need tearing down.
    const alreadyClosed = this.closed;
    this.closed = true;
    this.readerDone = true;
    this.state = 'disconnected';
    if (alreadyClosed) return;
    this.readLoopAbort?.abort();
    try {
      // `cancel()` returns a promise that rejects with the stream's error when
      // the stream already died (the usual reason to close a dropped session).
      // The surrounding try/catch is synchronous and cannot see that rejection,
      // so it surfaced as an unhandledRejection — fatal under Node's default.
      void Promise.resolve(this.reader?.cancel()).catch(() => undefined);
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    this.abortController?.abort();
    this.rejectStreamPending('transport closed');
    this.disconnectHandlers.splice(0, this.disconnectHandlers.length);
  }

  private markDisconnected(): void {
    if (this.state === 'connected') {
      this.state = 'disconnected';
      this.notifyDisconnect();
    }
  }
}

function invalidResponse(method: string, url: string, err: unknown): ToolError {
  return new ToolError({
    message: `Invalid JSON-RPC response: ${err instanceof Error ? err.message : 'parse failed'}`,
    code: 'TOOL_EXECUTION_FAILED',
    toolName: method,
    context: { transport: 'sse', url, phase: 'parse-json' },
    cause: err,
  });
}
