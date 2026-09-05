import { MCP_CONSTANTS } from './constants.js';
import type { JsonRpcResponse, ToolCallResult } from './contracts.js';
import { parseServerMetadata } from './protocol.js';
import { readBodyCapped } from './read-body.js';
import { normalizeMCPTools } from './tool-schema.js';
import {
  BaseHTTPTransport,
  createTimeoutSignal,
  type HttpTransportOptions,
  makeAbortError,
} from './transport-base.js';
import {
  assertMatchingJsonRpcResult,
  extractJsonRpcEnvelopes,
  extractJsonRpcResults,
  isJsonRpcResult,
  type JsonRpcResult,
} from './transport-jsonrpc.js';

// ---------------------------------------------------------------------------
// Streamable HTTP Transport
// ---------------------------------------------------------------------------

/**
 * Streamable HTTP transport for MCP.
 *
 * Uses session-based HTTP with NDJSON responses.
 */
export class StreamableHTTPTransport extends BaseHTTPTransport {
  private _nextId = 1;
  private sessionId?: string | undefined;

  constructor(opts: HttpTransportOptions) {
    super(opts, 'StreamableHTTP');
  }

  protected override genId(): number {
    return this._nextId++;
  }

  private consumeResponseText(text: string, requestId: number): JsonRpcResult | undefined {
    const envelopes = extractJsonRpcEnvelopes(text);
    for (const envelope of envelopes) {
      if ('method' in envelope && envelope.id === undefined) {
        this.handleNotification(envelope.method);
      }
    }
    const responses = envelopes.filter(isJsonRpcResult);
    return responses.find((envelope) => envelope.id === requestId) ?? responses[0];
  }

  private handleNotification(method: string): void {
    if (method === 'notifications/resources/list_changed') {
      this.notifyResourcesChanged();
    } else if (method === 'notifications/prompts/list_changed') {
      this.notifyPromptsChanged();
    } else if (method === 'notifications/tools/list_changed') {
      void this.refreshTools();
    }
  }

  private async refreshTools(): Promise<void> {
    try {
      const response = await this.postRaw('tools/list', {});
      if (response.error) return;
      const tools = normalizeMCPTools(
        (response.result as { tools?: unknown | undefined } | undefined)?.tools,
      );
      this.tools.splice(0, this.tools.length, ...tools);
      for (const listener of this.toolsChangedListeners) {
        try {
          listener([...tools]);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* keep the last known tool catalog */
    }
  }

  async connect(): Promise<void> {
    this.state = 'connecting';
    this.serverMetadata = undefined;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const startupTimer = setTimeout(() => this.abortController?.abort(), this.timeout);

    try {
      const initFetchOpts: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: this.genId(),
          method: 'initialize',
          params: {
            protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
            capabilities: { tools: {} },
            clientInfo: MCP_CONSTANTS.CLIENT_INFO,
          },
        }),
        signal,
      };
      this.applyTlsAgent(initFetchOpts);
      const initRes = await this.fetchWithAuthorization(this.url, initFetchOpts, signal);

      if (!initRes.ok) {
        throw new Error(`initialize HTTP ${initRes.status}: ${initRes.statusText}`);
      }

      const contentType = initRes.headers.get('content-type') ?? '';
      let data: JsonRpcResult | undefined;

      if (contentType.includes('application/json')) {
        // Capped read — connect() used to call initRes.json() here, which
        // buffered the whole body; every other request path enforces the cap.
        const parsed = JSON.parse(await readBodyCapped(initRes));
        if (isJsonRpcResult(parsed)) data = parsed;
      } else {
        // text/event-stream or NDJSON — handle SSE `data:` framing.
        data = extractJsonRpcResults(await readBodyCapped(initRes))[0];
      }

      if (!data) {
        throw new Error('Could not parse initialize response');
      }
      data = assertMatchingJsonRpcResult(data, this._nextId - 1, 'initialize');

      if (data.error) {
        throw new Error(`initialize failed: ${data.error.message}`);
      }
      this.serverMetadata = parseServerMetadata(data.result);
      this.protocolVersion = this.serverMetadata.protocolVersion;

      // MCP Streamable HTTP spec: the server assigns a session via the
      // `Mcp-Session-Id` response header, which the client must echo on every
      // subsequent request. (Header lookups are case-insensitive.)
      this.sessionId = initRes.headers.get('mcp-session-id') ?? undefined;
      await this.postRaw('notifications/initialized', {});

      const toolsRes = await this.postRaw('tools/list', {});
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

  private async postRaw(
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
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
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
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // Notifications get no JSON-RPC reply (the server returns 202 / empty body).
      if (method.startsWith('notifications/')) {
        // 202/empty in practice, but a hostile server can attach a huge body —
        // drain it through the cap instead of res.text().
        await readBodyCapped(res).catch(() => undefined);
        return { jsonrpc: '2.0', id };
      }

      const match = this.consumeResponseText(await readBodyCapped(res), id);
      if (match) {
        return assertMatchingJsonRpcResult(match, id, method);
      }
      throw new Error('Could not parse response as JSON-RPC');
    } catch (err) {
      if (external?.aborted && !method.startsWith('notifications/')) {
        // MCP spec cancellation: tell the server to stop the in-flight
        // request. Best-effort fire-and-forget.
        void this.postRaw('notifications/cancelled', {
          requestId: id,
          reason: 'client aborted',
        }).catch(() => {});
        throw makeAbortError(method);
      }
      this.markDisconnected();
      throw err;
    } finally {
      timeoutSignal.dispose();
    }
  }

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE/streamable-http transports. */
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
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.headers,
      },
      body,
      signal: timeoutSignal.signal,
    };
    this.applyTlsAgent(fetchOpts);
    try {
      const res = await this.fetchWithAuthorization(this.url, fetchOpts, timeoutSignal.signal);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      if (method.startsWith('notifications/')) {
        // 202/empty in practice, but a hostile server can attach a huge body —
        // drain it through the cap instead of res.text().
        await readBodyCapped(res).catch(() => undefined);
        return { jsonrpc: '2.0', id };
      }

      const parsed = this.consumeResponseText(await readBodyCapped(res), id);
      if (parsed) {
        // Convert JsonRpcResult to JsonRpcResponse
        return {
          jsonrpc: '2.0',
          id,
          result: parsed.result,
          error: parsed.error,
        };
      }
      throw new Error('Could not parse response as JSON-RPC');
    } catch (err) {
      if (external?.aborted && !method.startsWith('notifications/')) {
        void this.postRaw('notifications/cancelled', {
          requestId: id,
          reason: 'client aborted',
        }).catch(() => {});
        throw makeAbortError(method);
      }
      this.markDisconnected();
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
      throw new Error(`streamable-http transport not connected (state=${this.state})`);
    }
    const res = await this.postRaw('tools/call', { name, arguments: input }, opts);
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

  async close(): Promise<void> {
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.abortController?.abort();
    // Intentionally do NOT fire disconnect handlers — those trigger
    // reconnection in the registry, which would fight an explicit close().
    this.disconnectHandlers.splice(0, this.disconnectHandlers.length);
  }

  private markDisconnected(): void {
    if (this.state === 'connected') {
      this.state = 'disconnected';
      this.notifyDisconnect();
    }
  }
}
