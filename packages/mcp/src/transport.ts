import { randomBytes } from 'node:crypto';
import * as https from 'node:https';
import * as net from 'node:net';
import { ConfigError, ToolError, type HttpDispatcher } from '@wrongstack/core';
import type { ConnectionState, JsonRpcResponse, MCPTool, ToolCallResult } from './client.js';
import { MCP_CONSTANTS } from './constants.js';
import { normalizeMCPTools } from './tool-schema.js';

export type JsonRpcResult = {
  jsonrpc: string;
  id?: number | undefined;
  result?: unknown | undefined;
  error?: { code: number | undefined; message: string; data?: unknown | undefined } | undefined;
};

export interface HttpTransportOptions {
  name: string;
  url: string;
  headers?: Record<string, string> | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /**
   * Per-request TLS configuration. When set, an https.Agent is created
   * and passed to fetch via the `dispatch` option. This avoids globally
   * disabling certificate validation (NODE_TLS_REJECT_UNAUTHORIZED) which
   * would affect all provider API calls in the same process.
   *
   * ⚠️ Security gate: `rejectUnauthorized: false` REQUIRES
   * `WRONGSTACK_UNSAFE_MCP_TLS=1` as an explicit opt-in.
   *
   * Without this gate, an active network attacker between the client and the
   * MCP server can read and modify tool calls and responses. Only use this
   * for local development with self-signed certificates; production MCP
   * servers must present a valid certificate.
   */
  tls?: { ca?: string | undefined; rejectUnauthorized?: boolean | undefined };
}

function isTlsUnsafeAllowed(): boolean {
  return process.env['WRONGSTACK_UNSAFE_MCP_TLS'] === '1';
}

/**
 * Validate that an MCP transport URL is not targeting private/internal
 * addresses. This is a defense-in-depth SSRF check — MCP servers are
 * typically local or LAN, but config manipulation could point to metadata
 * endpoints (169.254.169.254) or internal services.
 *
 * The check is intentionally lighter than fetch.ts's assertNotPrivate:
 * MCP URLs are admin-configured, not LLM-supplied, so we only block
 * the most obvious attack vectors.
 */
function validateTransportUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigError({
      message: `MCP transport: invalid URL "${rawUrl}"`,
      code: 'CONFIG_INVALID',
      context: { field: 'url', rawUrl },
    });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError({
      message: `MCP transport: unsupported protocol "${url.protocol}" — only http/https allowed`,
      code: 'CONFIG_INVALID',
      context: { field: 'url', rawUrl, protocol: url.protocol },
    });
  }

  const hostname = url.hostname;
  // URL.hostname keeps the brackets on IPv6 literals; strip them so net.isIP
  // and prefix checks see the bare address.
  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  // Block cloud metadata endpoints (IMDS) — these are never valid MCP servers
  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    const parts = host.split('.').map(Number);
    // 169.254.x.x (link-local / IMDS)
    if (parts[0] === 169 && parts[1] === 254) {
      throw new ConfigError({
        message: `MCP transport: blocked link-local/IMDS address "${hostname}" — likely not a valid MCP server`,
        code: 'CONFIG_INVALID',
        context: { field: 'url', rawUrl, hostname },
      });
    }
  } else if (ipVersion === 6) {
    const lower = host.toLowerCase();
    // fe80::/10 link-local (first hextet fe80–febf) and the AWS IPv6 IMDS
    // address fd00:ec2::254 — the IPv6 counterparts of the IPv4 block above.
    const linkLocal = /^fe[89ab]/.test(lower);
    if (linkLocal || lower === 'fd00:ec2::254') {
      throw new ConfigError({
        message: `MCP transport: blocked link-local/IMDS address "${hostname}" — likely not a valid MCP server`,
        code: 'CONFIG_INVALID',
        context: { field: 'url', rawUrl, hostname },
      });
    }
  }

  // Plaintext http: is only permitted for loopback addresses where the
  // attacker would already need machine-level access. Remote HTTP MCP servers
  // must use TLS so an active network attacker cannot read or modify tool
  // calls and responses.
  if (url.protocol === 'http:') {
    const isLoopback =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname === '[::1]';
    if (!isLoopback) {
      throw new ConfigError({
        message: `MCP transport: http:// is only allowed for loopback addresses; use https:// for "${hostname}"`,
        code: 'CONFIG_INVALID',
        context: { field: 'url', rawUrl, hostname, protocol: url.protocol },
      });
    }
  }
}

/**
 * SSE-based MCP transport using native fetch.
 *
 * Communication pattern:
 * - Client connects to SSE endpoint to receive server messages (JSON-RPC events)
 * - Client sends JSON-RPC requests via HTTP POST to the same or separate endpoint
 * - Server sends results/errors via the SSE stream
 *
 * The SSE reader parses the SSE protocol (event:, data:, blank line to dispatch).
 */
/**
 * Cap on the pending-line buffer. The upstream SSE parser
 * (packages/providers/src/sse.ts) already enforces 256 KB; this
 * reader is used only inside MCP HTTP transports, but defense-in-depth
 * says we should never let a malicious stream pin memory.
 */
const SSE_READER_MAX_BUFFER = 256 * 1024;
/** Max data lines buffered per event before flush. Prevents a malicious
 *  server from accumulating unbounded data: lines without a blank-line
 *  delimiter would grow this array indefinitely. */
const SSE_READER_MAX_DATA_LINES = 1024;

export class SSEReader {
  private buffer = '';
  private dataLines: string[] = [];
  private listeners: Array<
    (event: { jsonrpc?: string | undefined; method?: string | undefined; params?: unknown | undefined; id?: number | undefined }) => void
  > = [];

  onMessage(
    cb: (data: { jsonrpc?: string | undefined; method?: string | undefined; params?: unknown | undefined; id?: number | undefined }) => void,
  ): () => void {
    this.listeners.push(cb);
    return () => {
      const idx = this.listeners.indexOf(cb);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  feed(chunk: string): void {
    // Guard against a single chunk that exceeds the buffer cap.
    if (chunk.length > SSE_READER_MAX_BUFFER) {
      throw new ToolError({
        message: `SSE: chunk size ${chunk.length} exceeds max buffer ${SSE_READER_MAX_BUFFER} — refusing to accumulate`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'mcp_transport_sse_reader',
        context: { phase: 'feed', chunkLength: chunk.length, maxBuffer: SSE_READER_MAX_BUFFER },
      });
    }
    this.buffer += chunk;
    if (this.buffer.length > SSE_READER_MAX_BUFFER) {
      throw new ToolError({
        message: `SSE: pending line exceeds ${SSE_READER_MAX_BUFFER} bytes — upstream is not framing events`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'mcp_transport_sse_reader',
        context: { phase: 'feed', bufferLength: this.buffer.length, maxBuffer: SSE_READER_MAX_BUFFER },
      });
    }
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      idx = this.buffer.indexOf('\n');

      this.processLine(line);
    }
  }

  private processLine(line: string): void {
    if (line === '') {
      this.flush();
      return;
    }
    if (line.startsWith(':')) return;

    const colonIdx = line.indexOf(':');
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
    let value = colonIdx === -1 ? '' : line.slice(colonIdx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      // The current transport only cares about JSON-RPC payloads in data
      // fields. Event names are accepted for spec compatibility.
    } else if (field === 'data') {
      if (this.dataLines.length >= SSE_READER_MAX_DATA_LINES) {
        throw new ToolError({
          message: `SSE: exceeded ${SSE_READER_MAX_DATA_LINES} data lines per event — upstream is not sending blank-line delimiters`,
          code: 'TOOL_EXECUTION_FAILED',
          toolName: 'mcp_transport_sse_reader',
          context: { phase: 'processLine', dataLineCount: this.dataLines.length, maxDataLines: SSE_READER_MAX_DATA_LINES },
        });
      }
      this.dataLines.push(value);
    }
  }

  private flush(): void {
    if (this.dataLines.length === 0) {
      return;
    }
    const data = this.dataLines.join('\n').trim();
    this.dataLines = [];
    if (!data) return;
    try {
      const parsed = JSON.parse(data) as {
        jsonrpc?: string | undefined;
        method?: string | undefined;
        params?: unknown | undefined;
        id?: number | undefined;
      };
      this.dispatch(parsed);
    } catch {
      // ignore parse errors
    }
  }

  private dispatch(msg: {
    jsonrpc?: string | undefined;
    method?: string | undefined;
    params?: unknown | undefined;
    id?: number | undefined;
  }): void {
    for (const cb of this.listeners) {
      try {
        cb(msg);
      } catch {
        /* ignore */
      }
    }
  }

  reset(): void {
    this.buffer = '';
    this.dataLines = [];
    this.listeners = [];
  }
}

function isJsonRpcResult(v: unknown): v is JsonRpcResult {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as JsonRpcResult;
  if (r.jsonrpc !== '2.0') return false;
  if (r.error !== undefined) {
    return (
      typeof r.error === 'object' &&
      r.error !== null &&
      typeof r.error.code === 'number' &&
      typeof r.error.message === 'string'
    );
  }
  return 'result' in r || r.id === undefined;
}

/**
 * Extract JSON-RPC envelopes from a streamable-http response body. Handles BOTH
 * plain NDJSON (one JSON object per line) AND SSE framing
 * (`event: message\ndata: {...}` blocks) — modern MCP servers (e.g. Context7)
 * reply with `text/event-stream` even on a single POST, so the data must be
 * un-prefixed before parsing. Multi-line `data:` values within one event are
 * joined per the SSE spec.
 */
export function extractJsonRpcResults(text: string): JsonRpcResult[] {
  const out: JsonRpcResult[] = [];
  let dataBuf: string[] = [];
  const flush = () => {
    if (dataBuf.length === 0) return;
    const joined = dataBuf.join('\n').trim();
    dataBuf = [];
    if (!joined) return;
    try {
      const parsed = JSON.parse(joined);
      if (isJsonRpcResult(parsed)) out.push(parsed);
    } catch {
      /* ignore non-JSON event data */
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') {
      flush(); // blank line ends an SSE event
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment
    if (line.startsWith('data:')) {
      let v = line.slice(5);
      if (v.startsWith(' ')) v = v.slice(1);
      dataBuf.push(v);
      continue;
    }
    if (line.startsWith('event:') || line.startsWith('id:') || line.startsWith('retry:')) {
      continue; // other SSE fields
    }
    // Plain NDJSON line (no SSE framing).
    const trimmed = line.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (isJsonRpcResult(parsed)) out.push(parsed);
      } catch {
        /* ignore */
      }
    }
  }
  flush();
  return out;
}

/** Pick the JSON-RPC envelope matching `id`, or the first one if none matches. */
function pickJsonRpcResult(text: string, id: number): JsonRpcResult | undefined {
  const results = extractJsonRpcResults(text);
  return results.find((r) => r.id === id) ?? results[0];
}

function assertMatchingJsonRpcResult(
  data: unknown,
  expectedId: number,
  method: string,
): JsonRpcResult {
  if (!isJsonRpcResult(data)) {
    throw new ToolError({
      message: 'Invalid JSON-RPC response: not a JSON-RPC 2.0 envelope',
      code: 'TOOL_EXECUTION_FAILED',
      toolName: 'mcp_transport_jsonrpc',
      context: { method, expectedId, reason: 'not-jsonrpc-envelope' },
    });
  }
  if (data.id !== undefined && data.id !== expectedId) {
    throw new ToolError({
      message: `Invalid JSON-RPC response: id mismatch for ${method} (expected ${expectedId}, got ${data.id})`,
      code: 'TOOL_EXECUTION_FAILED',
      toolName: 'mcp_transport_jsonrpc',
      context: { method, expectedId, actualId: data.id, reason: 'id-mismatch' },
    });
  }
  if (data.id === undefined && !method.startsWith('notifications/')) {
    throw new ToolError({
      message: `Invalid JSON-RPC response: missing id for ${method}`,
      code: 'TOOL_EXECUTION_FAILED',
      toolName: 'mcp_transport_jsonrpc',
      context: { method, expectedId, reason: 'missing-id' },
    });
  }
  return data;
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(parent?.reason);
  if (parent?.aborted) {
    ctrl.abort(parent.reason);
  } else {
    parent?.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(
    () => ctrl.abort(new Error(`MCP HTTP request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Shared base class — consolidates all duplicated fields, constructor logic,
// and private helpers that are identical between SSETransport and
// StreamableHTTPTransport.
// ---------------------------------------------------------------------------

/**
 * Fields and methods shared by all HTTP-based MCP transports.
 * Subclasses override `connect()`, `close()`, `callTool()`, `request()`.
 */
export abstract class BaseHTTPTransport {
  protected state: ConnectionState = 'idle';
  protected readonly url: string;
  protected readonly headers: Record<string, string>;
  protected readonly timeout: number;
  protected readonly requestTimeout: number;
  /** Per-request TLS agent — created once from HttpTransportOptions.tls */
  protected readonly tlsAgent?: https.Agent | undefined;
  protected readonly tools: MCPTool[] = [];
  protected abortController?: AbortController | undefined;
  protected readonly disconnectHandlers: Array<() => void> = [];
  protected readonly toolsChangedListeners = new Set<(tools: MCPTool[]) => void>();

  constructor(opts: HttpTransportOptions, transportName: string) {
    validateTransportUrl(opts.url);
    this.url = opts.url;
    this.headers = { ...opts.headers };
    this.timeout = opts.startupTimeoutMs ?? 10_000;
    this.requestTimeout = opts.requestTimeoutMs ?? 60_000;
    if (opts.tls) {
      if (opts.tls.rejectUnauthorized === false) {
        if (!isTlsUnsafeAllowed()) {
          throw new ConfigError({
            message:
              `[mcp:${transportName}] TLS verification disabled — set WRONGSTACK_UNSAFE_MCP_TLS=1 ` +
              `to allow. Rejecting insecure configuration for ${this.url}.`,
            code: 'CONFIG_INVALID',
            context: { field: 'tls.rejectUnauthorized', transportName, url: this.url },
          });
        }
        console.error(
          `[mcp:${transportName}] ⚠️ TLS verification DISABLED for ${this.url}. ` +
          `Network attacks are possible — only use on localhost.`,
        );
      }
      this.tlsAgent = new https.Agent({
        ca: opts.tls.ca,
        rejectUnauthorized: opts.tls.rejectUnauthorized,
      });
    }
  }

  getState(): ConnectionState {
    return this.state;
  }

  listTools(): MCPTool[] {
    return [...this.tools];
  }

  onDisconnect(cb: () => void): () => void {
    this.disconnectHandlers.push(cb);
    return () => {
      const idx = this.disconnectHandlers.indexOf(cb);
      if (idx >= 0) this.disconnectHandlers.splice(idx, 1);
    };
  }

  onToolsChanged(cb: (tools: MCPTool[]) => void): () => void {
    this.toolsChangedListeners.add(cb);
    return () => {
      this.toolsChangedListeners.delete(cb);
    };
  }

  /**
   * Fire all disconnect handlers. Subclasses call this when the connection
   * drops so the registry can schedule reconnects.
   */
  protected notifyDisconnect(): void {
    for (const cb of this.disconnectHandlers) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Apply the pinned TLS agent (if configured) to a `RequestInit` object.
   * Uses `HttpDispatcher` from `@wrongstack/core`'s dispatcher-types shim,
   * which declares `https.Agent` compatible with `RequestInit.dispatcher`.
   * Verified safe: https.Agent implements the `dispatch(req, opts)` method
   * that fetch requires at runtime.
   */
  protected applyTlsAgent(fetchOpts: RequestInit): void {
    if (this.tlsAgent) {
      // The global `RequestInit.dispatcher` type now accepts `HttpDispatcher`
      // (see dispatcher-types.d.ts). The cast through `unknown` is the standard
      // pattern for "I know this is compatible at runtime."
      fetchOpts.dispatcher = this.tlsAgent as never as HttpDispatcher;
    }
  }

  /** Generate the next JSON-RPC request id. Subclasses provide the counter. */
  protected abstract genId(): number;
}

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
      const response = await fetch(sseUrl, fetchOpts);

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
        this.tools.splice(
          0,
          this.tools.length,
          ...normalizeMCPTools(result?.tools),
        );
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

  private async httpPost(method: string, params: unknown): Promise<JsonRpcResult> {
    const id = this.genId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timeoutSignal = createTimeoutSignal(this.abortController?.signal, this.requestTimeout);
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
    const res = await fetch(this.url, fetchOpts);

    try {
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
        data = await res.json();
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
    } finally {
      timeoutSignal.dispose();
    }
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new ToolError({
        message: `SSE transport not connected (state=${this.state})`,
        code: 'TOOL_EXECUTION_FAILED',
        toolName: name,
        context: { transport: 'sse', state: this.state },
      });
    }
    const res = await this.httpPost('tools/call', { name, arguments: input });
    if (res.error) {
      return { content: res.error.message, isError: true };
    }
    const result = res.result as { content?: unknown | undefined; isError?: boolean | undefined } | undefined;
    return {
      content: result?.content ?? '',
      isError: Boolean(result?.isError),
    };
  }

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE transports. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<JsonRpcResponse> {
    const id = this.genId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timeoutSignal = createTimeoutSignal(
      this.abortController?.signal,
      timeoutMs ?? this.requestTimeout,
    );
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
      const res = await fetch(this.url, fetchOpts);

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
        data = await res.json();
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

  async connect(): Promise<void> {
    this.state = 'connecting';
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
      const initRes = await fetch(this.url, initFetchOpts);

      if (!initRes.ok) {
        throw new Error(`initialize HTTP ${initRes.status}: ${initRes.statusText}`);
      }

      const contentType = initRes.headers.get('content-type') ?? '';
      let data: JsonRpcResult | undefined;

      if (contentType.includes('application/json')) {
        const parsed = await initRes.json();
        if (isJsonRpcResult(parsed)) data = parsed;
      } else {
        // text/event-stream or NDJSON — handle SSE `data:` framing.
        data = extractJsonRpcResults(await initRes.text())[0];
      }

      if (!data) {
        throw new Error('Could not parse initialize response');
      }
      data = assertMatchingJsonRpcResult(data, this._nextId - 1, 'initialize');

      if (data.error) {
        throw new Error(`initialize failed: ${data.error.message}`);
      }

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

  private async postRaw(method: string, params: unknown): Promise<JsonRpcResult> {
    const id = this.genId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timeoutSignal = createTimeoutSignal(this.abortController?.signal, this.requestTimeout);
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
    const res = await fetch(this.url, fetchOpts);

    try {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      // Notifications get no JSON-RPC reply (the server returns 202 / empty body).
      if (method.startsWith('notifications/')) {
        await res.text().catch(() => undefined);
        return { jsonrpc: '2.0' };
      }

      const match = pickJsonRpcResult(await res.text(), id);
      if (match) {
        return assertMatchingJsonRpcResult(match, id, method);
      }
      throw new Error('Could not parse response as JSON-RPC');
    } finally {
      timeoutSignal.dispose();
    }
  }

  /** Generic JSON-RPC request — used by MCPClient.request() for SSE/streamable-http transports. */
  async request(method: string, params: unknown, timeoutMs?: number): Promise<JsonRpcResponse> {
    const id = this.genId();
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timeoutSignal = createTimeoutSignal(
      this.abortController?.signal,
      timeoutMs ?? this.requestTimeout,
    );
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
    const res = await fetch(this.url, fetchOpts);

    try {
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      if (method.startsWith('notifications/')) {
        await res.text().catch(() => undefined);
        return { jsonrpc: '2.0', id };
      }

      const parsed = pickJsonRpcResult(await res.text(), id);
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
    } finally {
      timeoutSignal.dispose();
    }
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new Error(`streamable-http transport not connected (state=${this.state})`);
    }
    const res = await this.postRaw('tools/call', { name, arguments: input });
    if (res.error) {
      return { content: res.error.message, isError: true };
    }
    const result = res.result as { content?: unknown | undefined; isError?: boolean | undefined } | undefined;
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
}
