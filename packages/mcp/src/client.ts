import { type ChildProcess, spawn } from 'node:child_process';
import { buildChildEnv } from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { MCP_CONSTANTS } from './constants.js';
import { normalizeMCPTools } from './tool-schema.js';
import { type HttpTransportOptions, SSETransport, StreamableHTTPTransport } from './transport.js';

export type Transport = 'stdio' | 'sse' | 'streamable-http';

export interface MCPClientOptions {
  name: string;
  transport: Transport;
  command?: string | undefined;
  args?: string[] | undefined;
  env?: Record<string, string> | undefined;
  url?: string | undefined;
  headers?: Record<string, string> | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'failed'
  /** Lazy server: registered from a cached manifest, process not spawned. */
  | 'dormant';

export interface MCPTool {
  name: string;
  description?: string | undefined;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallResult {
  content: unknown;
  isError: boolean;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown | undefined;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown | undefined;
  error?: { code: number | undefined; message: string; data?: unknown | undefined } | undefined;
}

type ExitListener = (name: string, code: number | null, signal: string | null) => void;
/**
 * Fired when the server sends `notifications/tools/list_changed`. The
 * client refreshes its cached tool list before invoking listeners, so
 * subscribers can call `listTools()` for the fresh set.
 */
type ToolsChangedListener = (name: string, tools: MCPTool[]) => void;

/**
 * Lightweight MCP client supporting three transport types:
 * - stdio: spawns a child process and communicates over pipes
 * - sse: connects to an HTTP SSE endpoint for server events, POST for requests
 * - streamable-http: session-based HTTP transport with NDJSON responses
 */
export class MCPClient {
  private state: ConnectionState = 'idle';
  private child?: ChildProcess | undefined;
  private nextId = 1;
  /**
   * In-flight JSON-RPC calls keyed by id. `resolve` settles the call; `reject`
   * is invoked from {@link failPending} when the underlying transport dies
   * (stdio child exit, `close()`) so callers don't hang forever.
   */
  private readonly pending = new Map<
    number,
    { resolve: (res: JsonRpcResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private rxBuffer = '';
  private _tools: MCPTool[] = [];
  /** Cached tool list — survives reconnects so the registry can re-register without re-discovering. */
  private _toolsCache?: MCPTool[] | undefined;
  private _drainPending = false;
  private _lastNotifySkipped = false;
  // HTTP transports
  private sseTransport?: SSETransport | undefined;
  private httpTransport?: StreamableHTTPTransport | undefined;
  /** Notified when the stdio child process exits so the registry can attempt reconnect. */
  private readonly exitListeners = new Set<ExitListener>();
  /** Notified when the server announces a tools/list_changed notification. */
  private readonly toolsChangedListeners = new Set<ToolsChangedListener>();
  /** Notified when an HTTP transport (SSE or streamable-http) disconnects. */
  private readonly disconnectListeners = new Set<() => void>();

  constructor(public readonly opts: MCPClientOptions) {}

  getState(): ConnectionState {
    return this.state;
  }

  listTools(): MCPTool[] {
    return this._tools.length > 0
      ? [...this._tools]
      : this._toolsCache
        ? [...this._toolsCache]
        : [];
  }

  /** Returns true if a prior notify() call was skipped due to backpressure. */
  hadNotifySkipped(): boolean {
    return this._lastNotifySkipped;
  }

  /**
   * Register a listener for child-process exit events.
   * The registry uses this to trigger reconnection.
   */
  addExitListener(listener: ExitListener): void {
    this.exitListeners.add(listener);
  }

  removeExitListener(listener: ExitListener): void {
    this.exitListeners.delete(listener);
  }

  /**
   * Register a listener for transport disconnect events (SSE / streamable-http).
   * Used by the registry to trigger reconnection for HTTP-based servers.
   */
  addDisconnectListener(listener: () => void): void {
    this.disconnectListeners.add(listener);
  }

  removeDisconnectListener(listener: () => void): void {
    this.disconnectListeners.delete(listener);
  }

  async connect(): Promise<void> {
    this.state = 'connecting';

    if (this.opts.transport === 'stdio') {
      await this.connectStdio();
    } else if (this.opts.transport === 'sse') {
      await this.connectSSE();
    } else if (this.opts.transport === 'streamable-http') {
      await this.connectStreamableHTTP();
    } else {
      this.state = 'failed';
      throw new Error(`Unknown transport "${this.opts.transport}"`);
    }
  }

  private async connectStdio(): Promise<void> {
    if (!this.opts.command) {
      this.state = 'failed';
      throw new Error('MCP stdio transport requires "command"');
    }

    // Defense-in-depth: clear any rx state from a previous connect attempt
    // on this instance. The registry normally creates a fresh client per
    // (re)connect cycle, but a leftover rxBuffer from a half-initialized
    // attempt would corrupt JSON-RPC parsing on the new stream.
    this.rxBuffer = '';

    // On Windows, MCP servers are usually launched via `npx`/`npm`/`uvx`,
    // which resolve to `.cmd` shims. Since the CVE-2024-27980 fix Node refuses
    // to spawn `.cmd`/`.bat` without a shell (raw spawn throws ENOENT), so the
    // whole npx-based preset catalog is unusable without a shell. We pass the
    // full command line as a single string (with each token cmd.exe-quoted) and
    // `shell: true` — an empty args array avoids the DEP0190 warning that
    // `shell:true` + an args array triggers. Server command+args come from
    // config (admin-controlled), not the model, so shell use is not an
    // injection vector here.
    const isWin = process.platform === 'win32';
    const rawArgs = this.opts.args ?? [];
    const spawnEnv = buildChildEnv({ extra: this.opts.env });
    const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
    const child = isWin
      ? spawn([this.opts.command, ...rawArgs].map(quoteWindowsArg).join(' '), {
          env: spawnEnv,
          stdio,
          shell: true,
          // Without this every MCP server spawned from a console-less host
          // (WebUI server, scheduled runs) opens a visible console window.
          windowsHide: true,
        })
      : spawn(this.opts.command, rawArgs, { env: spawnEnv, stdio, windowsHide: true });
    this.child = child;

    child.stdout?.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    child.stderr?.on('data', () => {
      // intentionally discard stderr noise from server
    });
    child.on('exit', (code, signal) => {
      this.state = 'disconnected';
      // Reject any in-flight JSON-RPC requests — without this, callers
      // (e.g. callTool during a tool invocation) await forever on a child
      // that has already gone away.
      this.failPending(
        `MCP "${this.opts.name}" child exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
      );
      for (const listener of this.exitListeners) {
        try {
          listener(this.opts.name, code, signal);
        } catch {
          /* ignore */
        }
      }
    });
    child.on('error', (err: Error) => {
      this.state = 'failed';
      // Spawn/runtime errors (ENOENT, EACCES, ...) can fire *after* the child
      // handle exists but often without a matching 'exit' event. Without
      // failing in-flight requests here, callers awaiting the startup
      // `initialize` (or any tools/call) hang until their timeout instead of
      // rejecting promptly.
      this.failPending(`MCP "${this.opts.name}" child error: ${toErrorMessage(err)}`);
    });

    const initialize = await this.request(
      'initialize',
      {
        protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
        capabilities: { tools: {} },
        clientInfo: MCP_CONSTANTS.CLIENT_INFO,
      },
      this.opts.startupTimeoutMs ?? 10_000,
    );
    if (initialize.error) {
      this.state = 'failed';
      throw new Error(`MCP initialize failed: ${initialize.error.message}`);
    }
    try {
      await this.notify('notifications/initialized', {});
    } catch (err) {
      console.warn(
        '[MCP] notify("notifications/initialized") failed for "' +
          this.opts.name +
          '": ' +
          toErrorMessage(err),
      );
    }
    const toolsRes = await this.request('tools/list', {});
    if (toolsRes.error) {
      this._tools = [];
    } else {
      const result = toolsRes.result as { tools?: MCPTool[] | undefined } | undefined;
      this._tools = normalizeMCPTools(result?.tools);
    }
    // Cache tools so reconnect can re-register without re-discovering
    this._toolsCache = this._tools;
    this.state = 'connected';
  }

  private async connectSSE(): Promise<void> {
    if (!this.opts.url) {
      this.state = 'failed';
      throw new Error('MCP SSE transport requires "url"');
    }
    const httpOpts: HttpTransportOptions = {
      name: this.opts.name,
      url: this.opts.url,
      headers: this.opts.headers,
      startupTimeoutMs: this.opts.startupTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
    };
    this.sseTransport = new SSETransport(httpOpts);
    this.sseTransport.onDisconnect(() => {
      this.state = 'disconnected';
      for (const cb of this.disconnectListeners) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    });
    this.sseTransport.onToolsChanged((tools) => {
      this._tools = tools;
      // Keep the reconnect-recovery cache in sync. Without this, an empty
      // tools update would leave `_toolsCache` pointing at the previous
      // non-empty list, and `listTools()` would serve the stale cache
      // (since it falls back to the cache when `_tools` is empty).
      this._toolsCache = tools;
      for (const cb of this.toolsChangedListeners) {
        try {
          cb(this.opts.name, tools);
        } catch {
          /* ignore */
        }
      }
    });
    try {
      await this.sseTransport.connect();
    } catch (err) {
      // Tear down the partial transport deterministically: its SSE read
      // loop is async-running on a `ReadableStreamDefaultReader`, and its
      // `AbortController` is wired into the connect-time startup timer.
      // Without this close(), the reader can keep the response body alive
      // until GC. The transport is fresh (never reached the success
      // path), so close() is safe and idempotent.
      const t = this.sseTransport;
      this.sseTransport = undefined;
      await t.close().catch(() => {
        /* best-effort cleanup */
      });
      this.state = 'failed';
      throw err;
    }
    this._tools = this.sseTransport.listTools();
    this._toolsCache = this._tools;
    this.state = 'connected';
  }

  private async connectStreamableHTTP(): Promise<void> {
    if (!this.opts.url) {
      this.state = 'failed';
      throw new Error('MCP streamable-http transport requires "url"');
    }
    const httpOpts: HttpTransportOptions = {
      name: this.opts.name,
      url: this.opts.url,
      headers: this.opts.headers,
      startupTimeoutMs: this.opts.startupTimeoutMs,
      requestTimeoutMs: this.opts.requestTimeoutMs,
    };
    this.httpTransport = new StreamableHTTPTransport(httpOpts);
    this.httpTransport.onDisconnect(() => {
      this.state = 'disconnected';
      for (const cb of this.disconnectListeners) {
        try {
          cb();
        } catch {
          /* ignore */
        }
      }
    });
    this.httpTransport.onToolsChanged((tools) => {
      this._tools = tools;
      // Same cache-sync reasoning as the SSE branch above — keep
      // `_toolsCache` in lockstep with `_tools` on every transport
      // update so the empty-list fallback in `listTools()` never serves
      // stale data.
      this._toolsCache = tools;
      for (const cb of this.toolsChangedListeners) {
        try {
          cb(this.opts.name, tools);
        } catch {
          /* ignore */
        }
      }
    });
    try {
      await this.httpTransport.connect();
    } catch (err) {
      // Same teardown reasoning as the SSE branch — the partial transport's
      // `AbortController` and any in-flight header/state would otherwise
      // outlive this client instance until GC.
      const t = this.httpTransport;
      this.httpTransport = undefined;
      await t.close().catch(() => {
        /* best-effort cleanup */
      });
      this.state = 'failed';
      throw err;
    }
    this._tools = this.httpTransport.listTools();
    this._toolsCache = this._tools;
    this.state = 'connected';
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    if (this.state !== 'connected') {
      throw new Error(`MCP client "${this.opts.name}" not connected (state=${this.state})`);
    }
    // Delegate to the active transport
    if (this.sseTransport) {
      return this.sseTransport.callTool(name, input);
    }
    if (this.httpTransport) {
      return this.httpTransport.callTool(name, input);
    }
    // stdio
    const res = await this.request('tools/call', { name, arguments: input });
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
    if (this.child) {
      const child = this.child;
      // Always register the listener first. Checking exitCode/signalCode
      // before registering creates a TOCTOU race: the child can exit between
      // the check and child.once('exit', ...), so the listener never fires
      // and exitPromise hangs forever. The double-check below handles the
      // case where the child already exited before we registered.
      const exitPromise = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        if (child.exitCode !== null || child.signalCode !== null) resolve();
      });
      try {
        // Initial SIGTERM lets the server flush logs / clean up sockets.
        child.kill();
      } catch {
        // ignore
      }
      // Wait briefly for graceful exit, then escalate to SIGKILL. A stuck
      // server that ignores SIGTERM would otherwise stay alive after
      // close() returns — orphan child processes accumulate over restarts.
      const GRACEFUL_MS = 800;
      const FORCE_TIMEOUT_MS = 1200;
      const gracefulRace = await Promise.race([
        exitPromise.then(() => 'exited' as const),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), GRACEFUL_MS)),
      ]);
      if (gracefulRace === 'timeout') {
        try {
          // SIGKILL is ignored by `kill('SIGKILL')` on Windows in older
          // Node, but `child.kill('SIGKILL')` maps to TerminateProcess
          // under the hood for spawned children since Node 18 — safe to
          // call cross-platform.
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        await Promise.race([
          exitPromise,
          new Promise<void>((resolve) => setTimeout(resolve, FORCE_TIMEOUT_MS)),
        ]);
      }
    }
    // Reject pending requests BEFORE closing transports. This matters for
    // in-flight HTTP requests: they are not yet in `this.pending` (waiting
    // for a response from the network), so failPending() must run while the
    // transport is still alive. After this, the transport close is safe to
    // call even on a never-started or HTTP-only client — the exit handler
    // may have already run failPending, but calling it again with the same
    // pending set is a no-op (failPending guards on `this.pending.size`).
    this.failPending(`MCP "${this.opts.name}" closed`);
    this.sseTransport?.close();
    this.httpTransport?.close();
    this.state = 'disconnected';
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs = this.opts.requestTimeoutMs ?? 60_000,
  ): Promise<JsonRpcResponse> {
    // For HTTP transports, delegate to the transport's request method.
    // SSE and streamable-http both use postRaw which handles the full
    // round-trip including timeout signal.
    if (this.sseTransport) return this.sseTransport.request(method, params, timeoutMs);
    if (this.httpTransport) return this.httpTransport.request(method, params, timeoutMs);

    // stdio path
    const id = this.nextId++;
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`MCP "${this.opts.name}" request "${method}" timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) {
        // No writable stdin (child never spawned, already exited, or stream
        // destroyed). Reject immediately instead of leaving the request
        // pending until it times out.
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) clearTimeout(pending.timer);
        reject(new Error(`MCP "${this.opts.name}" request "${method}": stdin not writable`));
        return;
      }
      try {
        stdin.write(JSON.stringify(req) + '\n');
      } catch (err) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        if (pending) clearTimeout(pending.timer);
        reject(err);
      }
    });
  }

  /**
   * Reject every in-flight {@link request} call. Used when the underlying
   * transport dies — without this, callers awaiting `tools/call` over a
   * killed stdio child or a closed transport would hang indefinitely.
   */
  private failPending(reason: string): void {
    if (this.pending.size === 0) return;
    const err = new Error(reason);
    for (const [, entry] of this.pending) {
      try {
        clearTimeout(entry.timer);
        entry.reject(err);
      } catch {
        /* ignore */
      }
    }
    this.pending.clear();
  }

  private async notify(method: string, params: unknown): Promise<void> {
    const req = { jsonrpc: '2.0', method, params };
    const encoded = JSON.stringify(req) + '\n';
    try {
      const ok = this.child?.stdin?.write(encoded);
      if (!ok) {
        // Only the first caller waits for drain; others just warn and return.
        // This avoids a race where two concurrent notify() calls each start
        // their own drain-wait, then both resolve and the buffer is still full.
        if (this._drainPending) {
          this._lastNotifySkipped = true;
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'mcp.notify_skipped_backpressure',
              server: this.opts.name,
              method,
              message: 'stdin buffer backpressure (already waiting for drain)',
              timestamp: new Date().toISOString(),
            }),
          );
          return;
        }
        this._drainPending = true;
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            this.child?.stdin?.removeListener?.('drain', onDrain);
            this.child?.stdin?.removeListener?.('error', onError);
            this._drainPending = false;
            reject(new Error(`MCP notify("${method}") drain timeout`));
          }, 500);
          const onDrain = () => {
            clearTimeout(timeout);
            this.child?.stdin?.removeListener?.('drain', onDrain);
            this.child?.stdin?.removeListener?.('error', onError);
            this._drainPending = false;
            resolve();
          };
          const onError = (err: Error) => {
            clearTimeout(timeout);
            this.child?.stdin?.removeListener?.('drain', onDrain);
            this.child?.stdin?.removeListener?.('error', onError);
            this._drainPending = false;
            reject(err);
          };
          this.child?.stdin?.once('drain', onDrain);
          this.child?.stdin?.once('error', onError);
        });
      }
    } catch (err) {
      throw new Error(`[MCP] notify("${method}") failed: ${toErrorMessage(err)}`);
    }
  }

  private onData(s: string): void {
    this.rxBuffer += s;
    let idx = this.rxBuffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.rxBuffer.slice(0, idx).trim();
      this.rxBuffer = this.rxBuffer.slice(idx + 1);
      if (line) this.onLine(line);
      idx = this.rxBuffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let msg: JsonRpcResponse & { method?: string | undefined; params?: unknown | undefined };
    try {
      msg = JSON.parse(line) as JsonRpcResponse & {
        method?: string | undefined;
        params?: unknown | undefined;
      };
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const entry = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      entry?.resolve(msg);
      return;
    }
    // Notifications have a `method` but no `id`. The MCP spec defines
    // `notifications/tools/list_changed` for tool-set invalidation —
    // refresh the cache asynchronously and fire listeners so the
    // registry can re-register the wrapped tools.
    if (typeof msg.method === 'string' && msg.method === 'notifications/tools/list_changed') {
      void this.handleToolsListChanged();
    }
  }

  /**
   * L2-C: refresh the cached tool list when the server announces a
   * `tools/list_changed`. Listeners (the registry) re-wrap and
   * re-register. Failures are swallowed — a stale cache is preferable
   * to a hard crash on a transient notification glitch.
   */
  private async handleToolsListChanged(): Promise<void> {
    try {
      const toolsRes = await this.request('tools/list', {});
      const tools = normalizeMCPTools(
        (toolsRes.result as { tools?: unknown | undefined } | undefined)?.tools,
      );
      this._tools = tools;
      this._toolsCache = tools;
      for (const listener of this.toolsChangedListeners) {
        try {
          listener(this.opts.name, [...tools]);
        } catch {
          // listeners must be best-effort
        }
      }
    } catch {
      // ignore — keep the existing cache
    }
  }

  addToolsChangedListener(listener: ToolsChangedListener): void {
    this.toolsChangedListeners.add(listener);
  }

  removeToolsChangedListener(listener: ToolsChangedListener): void {
    this.toolsChangedListeners.delete(listener);
  }
}

/**
 * Quote a single argument for `cmd.exe` when spawning with `shell: true` on
 * Windows. Only args containing whitespace or quotes need wrapping; inside
 * double quotes cmd.exe escapes a literal `"` as `""`. Backslashes are literal
 * inside cmd quotes, so paths like `C:\Program Files\x` pass through unharmed.
 */
export function quoteWindowsArg(arg: string): string {
  if (!/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}
