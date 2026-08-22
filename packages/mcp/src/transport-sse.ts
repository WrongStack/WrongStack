import { randomBytes } from 'node:crypto';
import { ToolError } from '@wrongstack/core/types';
import { MCP_CONSTANTS } from './constants.js';
import type { JsonRpcResponse, ToolCallResult } from './contracts.js';
import { parseServerMetadata } from './protocol.js';
import { readBodyCapped } from './read-body.js';
import { SSEReader } from './sse-reader.js';
import { normalizeMCPTools } from './tool-schema.js';
import {
  BaseHTTPTransport,
  createTimeoutSignal,
  type HttpTransportOptions,
  makeAbortError,
} from './transport-base.js';
import { assertMatchingJsonRpcResult, type JsonRpcResult } from './transport-jsonrpc.js';

// ---------------------------------------------------------------------------
// SSE Transport
// ---------------------------------------------------------------------------

/**
 * SSE transport for MCP over HTTP.
 *
 * Uses native fetch API with ReadableStream to consume SSE events.
 * HTTP POST is used to send JSON-RPC requests.
 */
export class SSETransport extends BaseHTTPTransport {
  private _nextId = 1;
  private readerDone = false;
  private readLoopAbort?: AbortController | undefined;
  private reader?: globalThis.ReadableStreamDefaultReader<string> | undefined;

  constructor(opts: HttpTransportOptions) {
    super(opts, 'SSETransport');
  }

  protected override genId(): number {
    return this._nextId++;
  }

  /** Refresh tool list when server sends notifications/tools/list_changed. */
  private async handleToolsListChanged(): Promise<void> {
    try {
      const res = await this.httpPost('tools/list', {});
      if (!res.error) {
        this.tools.splice(
          0,
          this.tools.length,
          ...normalizeMCPTools((res.result as { tools?: unknown | undefined } | undefined)?.tools),
        );
        for (const cb of this.toolsChangedListeners) {
          try {
            cb([...this.tools]);
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore transient failures */
    }
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    this.serverMetadata = undefined;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const startupTimer = setTimeout(() => this.abortController?.abort(), this.timeout);

    try {
      const sseUrl = this.buildSSEUrl();
      const fetchOpts: RequestInit = {
        headers: this.headers,
        signal,
      };
      this.applyTlsAgent(fetchOpts);
      const response = await this.fetchWithAuthorization(sseUrl, fetchOpts, signal);

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
      this.readLoopAbort = new AbortController();

      sseReader.onMessage((msg) => {
        // Server-initiated notifications (no id). Handle list_changed for L2-C.
        if (msg.method && !msg.id) {
          if (msg.method === 'notifications/tools/list_changed') {
            void this.handleToolsListChanged();
          } else if (msg.method === 'notifications/resources/list_changed') {
            this.notifyResourcesChanged();
          } else if (msg.method === 'notifications/prompts/list_changed') {
            this.notifyPromptsChanged();
          }
        }
      });

      const reader = response.body.getReader();
      this.reader = {
        cancel: () => reader.cancel(),
        releaseLock: () => reader.releaseLock(),
      } as globalThis.ReadableStreamDefaultReader<string>;

      this.readSSEBody(reader, textDecoder, sseReader);

      const initRes = await this.httpPost('initialize', {
        protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: MCP_CONSTANTS.CLIENT_INFO,
      });

      if (initRes.error) {
        throw new ToolError({
          message: `initialize failed: ${initRes.error.message}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_initialize',
          context: { transport: 'sse', url: this.url },
        });
      }
      this.serverMetadata = parseServerMetadata(initRes.result);
      this.protocolVersion = this.serverMetadata.protocolVersion;

      try {
        await this.httpPost('notifications/initialized', {});
      } catch {
        // servers may not require it
      }

      const toolsRes = await this.httpPost('tools/list', {});
      if (toolsRes.error) {
        this.tools.splice(0, this.tools.length);
      } else {
        const result = toolsRes.result as { tools?: unknown | undefined } | undefined;
        this.tools.splice(0, this.tools.length, ...normalizeMCPTools(result?.tools));
      }

      this.state = 'connected';
      clearTimeout(startupTimer);
    } catch (err) {
      clearTimeout(startupTimer);
      this.state = 'failed';
      this.abortController.abort();
      throw err;
    }
  }

  private async readSSEBody(
    reader: globalThis.ReadableStreamDefaultReader<Uint8Array>,
    decoder: InstanceType<typeof TextDecoder>,
    sseReader: SSEReader,
  ): Promise<void> {
    try {
      while (!this.readerDone) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        sseReader.feed(chunk);
      }
    } catch {
      // SSE read error — connection lost. Transition to disconnected so
      // callTool and health checks see the correct state, then notify
      // disconnect handlers so the registry can schedule a reconnect.
      if (this.state !== 'disconnected' && this.state !== 'failed') {
        this.state = 'disconnected';
        this.notifyDisconnect();
      }
    }
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

  private async httpPost(
    method: string,
    params: unknown,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JsonRpcResult> {
    const id = this.genId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const external = opts?.signal;
    const parent =
      external && this.abortController
        ? AbortSignal.any([this.abortController.signal, external])
        : (external ?? this.abortController?.signal);
    const timeoutSignal = createTimeoutSignal(parent, this.requestTimeout);
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
      const res = await this.fetchWithAuthorization(this.url, fetchOpts, timeoutSignal.signal);
      if (!res.ok) {
        // Cap the body — a misbehaving server could return megabytes of
        // HTML and that's not useful in an error message anyway.
        const body = await res.text();
        const cap = MCP_CONSTANTS.REQUEST_LOG_CAP;
        const snippet =
          body.length > cap ? `${body.slice(0, cap)}… [${body.length} bytes total]` : body;
        throw new ToolError({
          message: `HTTP ${res.status}: ${snippet}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: method,
          context: { transport: 'sse', url: this.url, status: res.status },
        });
      }

      let data: unknown;
      try {
        data = JSON.parse(await readBodyCapped(res));
      } catch (err) {
        throw new ToolError({
          message: `Invalid JSON-RPC response: ${err instanceof Error ? err.message : 'parse failed'}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: method,
          context: { transport: 'sse', url: this.url, phase: 'parse-json' },
          cause: err,
        });
      }
      return assertMatchingJsonRpcResult(data, id, method);
    } catch (err) {
      if (external?.aborted && !method.startsWith('notifications/')) {
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
    const res = await this.httpPost('tools/call', { name, arguments: input }, opts);
    if (res.error) {
      return { content: res.error.message, isError: true };
    }
    const result = res.result as
      | { content?: unknown | undefined; isError?: boolean | undefined }
      | undefined;
    return {
      content: result?.content ?? '',
      isError: Boolean(result?.isError),
    };
  }

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE transports. */
  async request(
    method: string,
    params: unknown,
    timeoutMs?: number,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JsonRpcResponse> {
    const id = this.genId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const external = opts?.signal;
    const parent =
      external && this.abortController
        ? AbortSignal.any([this.abortController.signal, external])
        : (external ?? this.abortController?.signal);
    const timeoutSignal = createTimeoutSignal(parent, timeoutMs ?? this.requestTimeout);
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
    // dispose() clears the timeout timer and the parent-abort listener. It must
    // run on EVERY exit path (fetch rejection, !res.ok, JSON parse error,
    // mismatched result) — not just success — or the timer keeps ticking and the
    // abort listener leaks for the full timeout on each failed request.
    try {
      const res = await this.fetchWithAuthorization(this.url, fetchOpts, timeoutSignal.signal);

      if (!res.ok) {
        throw new ToolError({
          message: `HTTP ${res.status}: ${res.statusText}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: method,
          context: {
            transport: 'sse',
            url: this.url,
            status: res.status,
            statusText: res.statusText,
          },
        });
      }

      let data: unknown;
      try {
        data = JSON.parse(await readBodyCapped(res));
      } catch (err) {
        throw new ToolError({
          message: `Invalid JSON-RPC response: ${err instanceof Error ? err.message : 'parse failed'}`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: method,
          context: { transport: 'sse', url: this.url, phase: 'parse-json' },
          cause: err,
        });
      }
      const result = assertMatchingJsonRpcResult(data, id, method);
      return { jsonrpc: '2.0', id, result: result.result, error: result.error };
    } catch (err) {
      if (external?.aborted && !method.startsWith('notifications/')) {
        void this.httpPost('notifications/cancelled', {
          requestId: id,
          reason: 'client aborted',
        }).catch(() => {});
        throw makeAbortError(method);
      }
      throw err;
    } finally {
      timeoutSignal.dispose();
    }
  }

  async close(): Promise<void> {
    // Idempotent — safe to call multiple times.
    if (this.state === 'disconnected') return;
    this.readerDone = true;
    this.readLoopAbort?.abort();
    try {
      this.reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      this.reader?.releaseLock();
    } catch {
      /* ignore */
    }
    this.abortController?.abort();
    this.disconnectHandlers.splice(0, this.disconnectHandlers.length);
    this.state = 'disconnected';
  }
}
