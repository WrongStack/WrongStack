import { type ChildProcess, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { buildChildEnv, buildWin32CmdShimInvocation, toErrorMessage } from '@wrongstack/core/utils';
import type { ExitListener, MCPClientOptions } from './client-types.js';
import { assertSupportedServerProtocolVersion, MCP_CONSTANTS } from './constants.js';
import type { ConnectionState, JsonRpcResponse, MCPTool } from './contracts.js';
import type { ServerRequestResponder } from './elicitation.js';
import { isModernError, MODERN_PROTOCOL_VERSION, parseDiscovery } from './modern-protocol.js';
import { type MCPServerMetadata, parseServerMetadata } from './protocol.js';
import { listAllTools } from './tool-schema.js';

export interface ClientStdioHost {
  readonly opts: MCPClientOptions;
  state: ConnectionState;
  rxBuffer: string;
  rxBufferBytes: number;
  rxDecoder: StringDecoder;
  child: ChildProcess | undefined;
  onData(s: string): void;
  onLine(line: string): void;
  failPending(reason: string): void;
  readonly exitListeners: Set<ExitListener>;
  request(
    method: string,
    params: unknown,
    timeoutMs?: number | undefined,
    opts?: { signal?: AbortSignal | undefined },
  ): Promise<JsonRpcResponse>;
  readonly serverRequests: ServerRequestResponder;
  _serverMetadata: MCPServerMetadata | undefined;
  notify(method: string, params: unknown): Promise<void>;
  readonly toolCatalogVersion: number;
  readonly toolCatalogRevision: number;
  _tools: MCPTool[];
  _toolsCache: MCPTool[] | undefined;
  _drainPending: boolean;
  _lastNotifySkipped: boolean;
}

export async function connectStdio(host: ClientStdioHost): Promise<void> {
  if (host.opts.protocolMode !== undefined && !['auto', 'legacy'].includes(host.opts.protocolMode))
    throw new Error('MCP protocolMode must be auto or legacy');
  if (!host.opts.command) {
    host.state = 'failed';
    throw new Error('MCP stdio transport requires "command"');
  }

  // Defense-in-depth: clear any rx state from a previous connect attempt
  // on this instance. The registry normally creates a fresh client per
  // (re)connect cycle, but a leftover rxBuffer from a half-initialized
  // attempt would corrupt JSON-RPC parsing on the new stream.
  host.rxBuffer = '';
  host.rxBufferBytes = 0;
  host.rxDecoder = new StringDecoder('utf8');

  // On Windows, MCP servers are usually launched via `npx`/`npm`/`uvx`,
  // which resolve to `.cmd` shims. Since the CVE-2024-27980 fix Node refuses
  // to spawn `.cmd`/`.bat` without a shell (raw spawn throws ENOENT), so the
  // whole npx-based preset catalog is unusable without a shell. We pass the
  // full command line as a single string (with each token cmd.exe-quoted) and
  // `shell: true` — an empty args array avoids the DEP0190 warning that
  // `shell:true` + an args array triggers. Server command+args come from
  // config (admin-controlled), not the model, so shell use is not an
  // injection vector here.
  // Resolve passthroughEnv: forward explicitly-listed env var names from
  // the parent process to the child. This lets MCP server presets (GitHub,
  // Slack, Brave Search, …) get their API tokens without storing them in
  // config.json or being scrubbed by buildChildEnv()'s secret filter.
  const extraEnv: Record<string, string> = { ...host.opts.env };
  if (host.opts.passthroughEnv) {
    for (const name of host.opts.passthroughEnv) {
      const val = process.env[name];
      if (val !== undefined) {
        extraEnv[name] = val;
      }
    }
  }
  const isWin = process.platform === 'win32';
  const rawArgs = host.opts.args ?? [];
  const spawnEnv = buildChildEnv({ extra: extraEnv });
  const stdio: ['pipe', 'pipe', 'pipe'] = ['pipe', 'pipe', 'pipe'];
  // Windows cannot spawn a `.cmd`/`.bat` shim without a shell, but handing the
  // joined line to `shell: true` made `&`, `|`, `<`, `>` command separators —
  // and quoteWindowsArg left any argument without whitespace unquoted, so
  // `--flag=x&calc.exe` chained a second program. MCP `command`/`args` come
  // from config that the WebUI can write, so this was reachable. Use the
  // hardened cmd-shim builder instead: explicit `cmd.exe /d /c call`, every
  // token quoted, metacharacters refused outright (CMDI-005).
  const child = isWin
    ? (() => {
        const shim = buildWin32CmdShimInvocation(host.opts.command, rawArgs);
        return spawn(shim.command, shim.args, {
          env: spawnEnv,
          stdio,
          ...(host.opts.cwd ? { cwd: host.opts.cwd } : {}),
          windowsVerbatimArguments: shim.windowsVerbatimArguments,
          // Without this every MCP server spawned from a console-less host
          // (WebUI server, scheduled runs) opens a visible console window.
          windowsHide: true,
        });
      })()
    : spawn(host.opts.command, rawArgs, {
        env: spawnEnv,
        stdio,
        windowsHide: true,
        ...(host.opts.cwd ? { cwd: host.opts.cwd } : {}),
      });
  host.child = child;

  child.stdout?.on('data', (chunk: Buffer) => host.onData(host.rxDecoder.write(chunk)));
  child.stdout?.on('end', () => {
    // Flush the decoder's withheld bytes together with any buffered partial
    // line — a trailing fragment without a newline is still a frame.
    const tail = host.rxDecoder.end();
    if (tail) host.onData(tail);
    if (host.rxBuffer.trim()) {
      const line = host.rxBuffer.trim();
      host.rxBuffer = '';
      host.onLine(line);
    }
  });
  child.stderr?.on('data', () => {
    // intentionally discard stderr noise from server
  });
  child.stdin?.on('error', (err: Error) => {
    // Pipe failures such as EPIPE are emitted asynchronously by Writable;
    // the try/catch around stdin.write() cannot intercept them. Always own
    // the stream error so a child that exits during startup rejects pending
    // requests instead of surfacing as an uncaught process exception.
    host.failPending(`MCP "${host.opts.name}" stdin error: ${toErrorMessage(err)}`);
  });
  child.on('exit', (code, signal) => {
    host.state = 'disconnected';
    // Reject any in-flight JSON-RPC requests — without this, callers
    // (e.g. callTool during a tool invocation) await forever on a child
    // that has already gone away.
    host.failPending(
      `MCP "${host.opts.name}" child exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`,
    );
    for (const listener of host.exitListeners) {
      try {
        listener(host.opts.name, code, signal);
      } catch {
        /* ignore */
      }
    }
  });
  child.on('error', (err: Error) => {
    host.state = 'failed';
    // Spawn/runtime errors (ENOENT, EACCES, ...) can fire *after* the child
    // handle exists but often without a matching 'exit' event. Without
    // failing in-flight requests here, callers awaiting the startup
    // `initialize` (or any tools/call) hang until their timeout instead of
    // rejecting promptly.
    host.failPending(`MCP "${host.opts.name}" child error: ${toErrorMessage(err)}`);
  });

  const startupTimeoutMs =
    typeof host.opts.startupTimeoutMs === 'number' &&
    Number.isFinite(host.opts.startupTimeoutMs) &&
    host.opts.startupTimeoutMs > 0
      ? Math.min(host.opts.startupTimeoutMs, 2_147_483_647)
      : 10_000;
  const initialize = (): Promise<JsonRpcResponse> =>
    host.request(
      'initialize',
      {
        protocolVersion: MCP_CONSTANTS.PROTOCOL_VERSION,
        // Client capabilities: elicitation when the host can ask its user.
        // `tools` is a SERVER capability and never belonged here.
        capabilities: host.serverRequests.capabilities(),
        clientInfo: MCP_CONSTANTS.CLIENT_INFO,
      },
      startupTimeoutMs,
    );
  const legacyMetadata = (response: JsonRpcResponse): MCPServerMetadata => {
    if (response.error) throw new Error(`MCP initialize failed: ${response.error.message}`);
    try {
      return parseServerMetadata(response.result);
    } catch (err) {
      throw new Error(`MCP initialize returned malformed server metadata: ${toErrorMessage(err)}`);
    }
  };

  let legacy: MCPServerMetadata | undefined;
  if (host.opts.protocolMode !== 'legacy') {
    host._serverMetadata = {
      protocolVersion: MODERN_PROTOCOL_VERSION,
      capabilities: {},
      serverInfo: { name: host.opts.name, version: 'unknown' },
    };
    // Each request picks its framing when it is sent: discovery goes out as a
    // modern request, and clearing the metadata first sends initialize as a
    // plain legacy one. A modern win below sets the metadata again.
    const outcome = await negotiate(host.request('server/discover', {}, startupTimeoutMs), () => {
      host._serverMetadata = undefined;
      return initialize().then(legacyMetadata);
    });
    if (outcome.kind === 'modern') {
      host._serverMetadata = parseDiscovery(host.opts.name, outcome.response);
    } else if (outcome.kind === 'legacy') {
      legacy = outcome.metadata;
    } else {
      host.state = 'failed';
      throw outcome.error;
    }
  } else {
    try {
      legacy = legacyMetadata(await initialize());
    } catch (err) {
      host.state = 'failed';
      throw err;
    }
  }
  if (legacy) {
    host._serverMetadata = legacy;
    // stdio carries no `MCP-Protocol-Version` header, but the rule is the same:
    // a server that answered with a revision we do not implement is not a server
    // we can talk to. Throwing here means disconnecting — MCPClient.connect's
    // catch closes the client, which terminates the child process, so nothing is
    // left running behind the failed handshake.
    assertSupportedServerProtocolVersion(host.opts.name, host._serverMetadata.protocolVersion);
    try {
      await host.notify('notifications/initialized', {});
    } catch (err) {
      console.warn(
        '[MCP] notify("notifications/initialized") failed for "' +
          host.opts.name +
          '": ' +
          toErrorMessage(err),
      );
    }
  }
  const revision = host.toolCatalogRevision;
  const tools = (await listAllTools((params) => host.request('tools/list', params))) ?? [];
  if (host.state !== 'connecting' || host.child !== child) return;
  if (revision === host.toolCatalogRevision) {
    host._tools = tools;
    // Cache tools so reconnect can re-register without re-discovering
    host._toolsCache = host._tools;
  }
  host.state = 'connected';
}

export async function notifyStdio(
  host: ClientStdioHost,
  method: string,
  params: unknown,
): Promise<void> {
  if (host._drainPending) {
    host._lastNotifySkipped = true;
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'mcp.notify_skipped_backpressure',
        server: host.opts.name,
        method,
        message: 'stdin buffer backpressure (already waiting for drain)',
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }
  const stdin = host.child?.stdin;
  if (!stdin || stdin.destroyed === true || stdin.writable === false) {
    return;
  }
  const req = { jsonrpc: '2.0', method, params };
  const encoded = JSON.stringify(req) + '\n';
  try {
    const ok = stdin.write(encoded);
    if (!ok) {
      host._drainPending = true;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          stdin.removeListener?.('drain', onDrain);
          stdin.removeListener?.('error', onError);
          stdin.removeListener?.('close', onClose);
          host._drainPending = false;
          reject(new Error(`MCP notify("${method}") drain timeout`));
        }, 500);
        const onDrain = () => {
          clearTimeout(timeout);
          stdin.removeListener?.('drain', onDrain);
          stdin.removeListener?.('error', onError);
          stdin.removeListener?.('close', onClose);
          host._drainPending = false;
          resolve();
        };
        const onError = (err: Error) => {
          clearTimeout(timeout);
          stdin.removeListener?.('drain', onDrain);
          stdin.removeListener?.('error', onError);
          stdin.removeListener?.('close', onClose);
          host._drainPending = false;
          reject(err);
        };
        const onClose = () => onError(new Error(`MCP notify("${method}") stdin closed`));
        stdin.once?.('drain', onDrain);
        stdin.once?.('error', onError);
        stdin.once?.('close', onClose);
      });
    }
  } catch (err) {
    throw new Error(`[MCP] notify("${method}") failed: ${toErrorMessage(err)}`);
  }
}

/** How long `server/discover` runs alone before the legacy handshake also starts. */
const DISCOVERY_HEAD_START_MS = 1000;

type Negotiation =
  | { kind: 'modern'; response: JsonRpcResponse }
  | { kind: 'legacy'; metadata: MCPServerMetadata }
  | { kind: 'failed'; error: Error };

/**
 * Settle a stdio server's protocol revision.
 *
 * `server/discover` gets a head start. A server that has not answered by then
 * is either a legacy peer that ignores unknown requests or a modern one still
 * starting (npx and uvx launches routinely take longer), so the legacy
 * `initialize` goes out too while discovery keeps waiting: dropping the late
 * discovery answer is what failed a slow modern-only server. A modern answer
 * to discovery or a well-formed answer to initialize decides; when one of them
 * fails, the other can still decide, and initialize's failure is reported only
 * when discovery did not succeed either.
 */
async function negotiate(
  discover: Promise<JsonRpcResponse>,
  initialize: () => Promise<MCPServerMetadata>,
): Promise<Negotiation> {
  const modern = discover.then(
    (response): Negotiation | undefined =>
      !response.error || isModernError(response.error) ? { kind: 'modern', response } : undefined,
    () => undefined,
  );
  const runLegacy = (): Promise<Negotiation> =>
    initialize().then(
      (metadata): Negotiation => ({ kind: 'legacy', metadata }),
      (error: unknown): Negotiation => ({
        kind: 'failed',
        error: error instanceof Error ? error : new Error(toErrorMessage(error)),
      }),
    );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const headStart = new Promise<'waiting'>((resolve) => {
    timer = setTimeout(() => resolve('waiting'), DISCOVERY_HEAD_START_MS);
  });
  const early = await Promise.race([
    discover.then(
      () => 'answered' as const,
      () => 'answered' as const,
    ),
    headStart,
  ]);
  clearTimeout(timer);
  if (early === 'answered') return (await modern) ?? runLegacy();

  const legacy = runLegacy();
  return Promise.race([
    modern.then((outcome) => outcome ?? legacy),
    legacy.then((outcome) =>
      outcome.kind === 'legacy' ? outcome : modern.then((m) => m ?? outcome),
    ),
  ]);
}
