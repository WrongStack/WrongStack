/**
 * WrongStackACPServer — ACP v1 server-side entry point.
 *
 * Exposes WrongStack as an ACP-compatible agent. ACP clients (Zed, JetBrains
 * Junie, VS Code ACP extension) spawn this as a subprocess, send JSON-RPC
 * messages over stdio, and receive v1-protocol responses.
 *
 * Usage:
 *   node dist/agent/wrongstack-acp-agent.js
 *
 * Or via the CLI:
 *   wstack acp-server
 *
 * Wiring a real agent: this class is the surface; the bootstrap
 * binary uses a no-op echo by default so the binary is a useful
 * connectivity smoke test. For a real server, instantiate
 * `WrongStackACPServer` programmatically and pass a `runTurn`
 * produced by `makeACPServerAgentTurn({ agentFor: ... })` from
 * `./server-agent-turn.js`. The factory is responsible for building
 * a real core `Agent` (with the right provider, model, system prompt,
 * etc.) per session.
 *
 * Startup: stdout is JSON-RPC only by default. The legacy `[wstack-acp]\n`
 * marker can be enabled for older internal harnesses with
 * `legacyStartupMarker`, but ACP clients should rely on v1 initialize.
 */

import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isIP, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { expandIPv6, writeErr } from '@wrongstack/core/utils';
import type { ACPMessage } from '../types/acp-messages.js';
import {
  ACPProtocolHandler,
  type RunTurn,
  type RunTurnResult,
  type SessionPersistence,
} from './protocol-handler.js';
import { StdioTransport } from './stdio-transport.js';

export interface WrongStackACPServerOptions {
  runTurn?: RunTurn | undefined;
  defaultCwd?: string | undefined;
  agentName?: string | undefined;
  /**
   * Transport mode. 'stdio' (default) communicates over stdin/stdout.
   * When a number is provided, the server listens as an HTTP server on
   * that port, accepting Streamable HTTP (JSON-RPC over HTTP POST).
   */
  transport?: 'stdio' | number | undefined;
  /** Host for HTTP transport. Defaults to '127.0.0.1'. */
  host?: string | undefined;
  /**
   * Bearer token required for HTTP transport authentication. When set,
   * every HTTP request must include `Authorization: Bearer <token>` or
   * `?token=<token>` in the query string. Non-loopback HTTP binds require
   * a token; loopback-only development may remain unauthenticated.
   */
  authToken?: string | undefined;
  /** Emit the pre-v1 startup marker on stdio. Defaults to false. */
  legacyStartupMarker?: boolean | undefined;
  /**
   * Conversation-history source for `session/load` replay. Pass
   * `makeACPServerAgentTurn(...).replay` here so a reconnecting client
   * gets prior turns streamed back.
   */
  replayFor?:
    | ((sessionId: string) => Array<{ sessionUpdate: string; content: unknown }>)
    | undefined;
  /**
   * Cold-load seed hook. Pass `makeACPServerAgentTurn(...).seed` so a
   * restored session's Agent resumes the model context, not just the UI.
   */
  seedFor?:
    | ((sessionId: string, history: Array<{ sessionUpdate: string; content: unknown }>) => void)
    | undefined;
  /** Per-session cleanup hook, normally `makeACPServerAgentTurn(...).dispose`. */
  disposeFor?: ((sessionId: string) => void) | undefined;
  /**
   * Durable session store. When set, sessions + history are persisted and
   * restored across restarts for `session/load`. Pass an `ACPSessionStore`.
   */
  store?: SessionPersistence | undefined;
}

/** Bounded retry budget for a transient bind failure on an ephemeral port. */
const LISTEN_RETRY_LIMIT = 5;
const LISTEN_RETRY_BASE_MS = 25;

export class WrongStackACPServer {
  private readonly transport: StdioTransport;
  private readonly handler: ACPProtocolHandler;
  private readonly options: WrongStackACPServerOptions;
  /** HTTP server when transport mode is HTTP. */
  private httpServer: Server | null = null;
  /** Live sockets on `httpServer`; destroyed on `stop()` so `close()` settles. */
  private readonly httpSockets = new Set<Socket>();
  private running = false;

  constructor(opts: WrongStackACPServerOptions = {}) {
    this.options = opts;
    this.transport = new StdioTransport();
    const runTurn: RunTurn = opts.runTurn ?? defaultEchoRunTurn;
    this.handler = new ACPProtocolHandler({
      transport: this.transport,
      defaultCwd: opts.defaultCwd ?? process.cwd(),
      runTurn,
      agentName: opts.agentName,
      ...(opts.replayFor ? { replayFor: opts.replayFor } : {}),
      ...(opts.seedFor ? { seedFor: opts.seedFor } : {}),
      ...(opts.disposeFor ? { disposeFor: opts.disposeFor } : {}),
      ...(opts.store ? { store: opts.store } : {}),
    });
  }

  /**
   * Start the server. Mode depends on `options.transport`:
   * - 'stdio' (default): reads JSON-RPC from stdin, writes to stdout.
   * - number: listens as HTTP on the given port.
   */
  async start(): Promise<void> {
    const transportMode = this.options.transport;
    if (typeof transportMode === 'number') {
      await this.startHttp(transportMode);
    } else {
      await this.startStdio();
    }
  }

  private async startStdio(): Promise<void> {
    if (this.options.legacyStartupMarker) {
      this.transport.sendStartupMarker();
    }
    this.running = true;
    try {
      while (this.running) {
        const msg = await this.transport.read();
        if (!msg) break;
        const terminal = await this.handler.handleMessage(msg);
        if (terminal) break;
      }
    } finally {
      this.handler.close();
      this.transport.close();
    }
  }

  private async startHttp(port: number): Promise<void> {
    const host = this.options.host ?? '127.0.0.1';
    const handler = this.handler;
    const authToken = this.options.authToken?.trim();
    if (!authToken && !isLoopbackHost(host)) {
      throw new Error('ACP HTTP transport requires authToken for non-loopback hosts');
    }

    // Serialize HTTP requests to prevent concurrent transport.send races.
    // The ACPProtocolHandler stores a single transport reference; without
    // serialization, concurrent requests would overwrite each other's
    // monkey-patched send capture, causing cross-talk or lost responses.
    let httpChain: Promise<void> = Promise.resolve();

    const httpServer = createServer(async (req, res) => {
      // ── Authentication ──────────────────────────────────────────────
      // When an authToken is configured, require it on every request.
      // Accept `Authorization: Bearer <token>` header or `?token=<token>`
      // query parameter (the latter for browser clients).
      if (authToken) {
        const url = new URL(requestPath(req.url), `http://${host}:${port}`);
        const bearerToken = headerValue(req.headers.authorization)?.replace(/^Bearer\s+/i, '');
        // WS-109: `?token=` was accepted on any bind. That is the query-string
        // exposure class (C-598) the WebUI and HQ surfaces already close: the
        // token reaches browser history, `Referer` headers sent to third-party
        // origins, and reverse-proxy access logs — and this endpoint drives
        // `runTurn`, i.e. real tool and command execution. It stays available on
        // loopback, where those channels are local, and for non-browser clients
        // that legitimately cannot hold a header.
        //
        // Both sources are checked and EITHER may satisfy the gate. Picking one
        // (`queryToken ?? bearerToken`) meant a wrong `?token=` shadowed a valid
        // `Authorization` header and 401'd a caller that had presented a good
        // credential — a footgun with no upside.
        const queryToken = url.searchParams.get('token');
        const queryOk =
          queryToken !== null && isLoopbackPeer(req) && timingSafeTokenEqual(queryToken, authToken);
        // WS-110: this was `supplied !== authToken`. Every sibling auth surface
        // in this repo compares credentials in constant time (HQ's
        // `timingSafeTokenMatch`, the WebUI's `tokenMatches`, the mailbox and
        // governance credential stores); this one did not, on the one transport
        // that is reachable off-loopback by design.
        if (!queryOk && !timingSafeTokenEqual(bearerToken ?? '', authToken)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: -32001, message: 'Unauthorized' } }));
          return;
        }
      }

      // Origin guard. Real ACP/MCP clients (Zed, JetBrains, curl, the MCP SDK)
      // are non-browser and send no `Origin` header, so they are unaffected. A
      // browser making a cross-origin request DOES send `Origin`; reject it so a
      // malicious web page the user visits cannot reach this agent and
      // drive it (a real `runTurn` executes tools/commands — i.e. RCE).
      const selfOrigin = `http://${host}:${port}`;
      const reqOrigin = headerValue(req.headers.origin);
      if (reqOrigin && reqOrigin !== selfOrigin) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'cross-origin request forbidden' }));
        return;
      }
      if (reqOrigin) res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }

      // Reject oversized request bodies (CWE-400).
      const MAX_HTTP_BODY = 10 * 1024 * 1024;
      let body = '';
      let bodyBytes = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_HTTP_BODY) {
          tooLarge = true;
          break;
        }
        body += chunk;
      }
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -32700, message: 'Request body too large' } }));
        return;
      }

      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      // Notifications (no `id`) — e.g. `session/cancel` — must NOT queue behind
      // the request chain. A `session/prompt` awaits its whole turn while
      // holding the chain, so a cancel routed through the chain would only be
      // delivered after the very turn it is trying to stop already finished.
      // Cancel/exit produce no outbound sends, so they need neither the
      // send-capture swap nor the chain; deliver them immediately as an ack.
      const isNotification =
        typeof msg === 'object' &&
        msg !== null &&
        (msg as { id?: unknown }).id === undefined &&
        typeof (msg as { method?: unknown }).method === 'string';
      if (isNotification) {
        try {
          await handler.handleMessage(msg);
        } catch {
          /* best-effort: a cancel/exit that throws must not 500 the client */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ notifications: [] }));
        return;
      }

      // Serialize this request's processing through a chain so concurrent
      // HTTP requests can't race on the shared transport.send capture.
      const requestPromise = httpChain.then(async () => {
        const notifications: unknown[] = [];
        let response: ACPMessage | null = null;
        const originalSend = this.transport.send.bind(this.transport);
        this.transport.send = async (m: ACPMessage) => {
          if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
            response = m;
          } else if (m.method === 'session/update') {
            notifications.push(m.params);
          } else {
            notifications.push(m);
          }
        };

        try {
          await handler.handleMessage(msg);
        } finally {
          this.transport.send = originalSend;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        const responseBody =
          response !== null ? { ...(response as ACPMessage), notifications } : { notifications };
        res.end(JSON.stringify(responseBody));
      });

      // Chain the next request after this one completes (success or failure).
      httpChain = requestPromise.catch(() => undefined);

      // Await the chained promise so the response is sent before the
      // function returns. Errors are caught by the chain wrapper.
      try {
        await requestPromise;
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: -32603, message: 'Internal error' } }));
      }
    });

    // Track live sockets. `server.close()` only stops accepting new
    // connections; keep-alive sockets (every `fetch` client holds one open)
    // keep the handle — and its kernel buffers — alive indefinitely. On
    // Windows that accumulation is what eventually surfaces as `ENOBUFS`.
    this.httpServer = httpServer;
    const sockets = this.httpSockets;
    httpServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    await this.listenWithRetry(port, host);
    // Report the port actually bound: `port: 0` means "pick an ephemeral one",
    // so echoing the requested value would print a literal `:0`.
    const bound = httpServer.address();
    const shown = typeof bound === 'object' && bound ? bound.port : port;
    writeErr(`[wstack-acp] HTTP server listening on http://${host}:${shown}\n`);
    this.running = true;
  }

  /**
   * `listen()` reports failure through an `'error'` event, not the callback.
   * Without a listener that event is an unhandled exception *and* the start
   * promise never settles — a hang rather than a diagnosable failure.
   *
   * An ephemeral bind (`port === 0`) additionally retries the transient
   * resource-exhaustion codes: under a saturated parallel test run the OS can
   * momentarily have no buffer or port to hand out even though nothing is wrong.
   */
  private listenWithRetry(port: number, host: string, attempt = 0): Promise<void> {
    const server = this.httpServer;
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve();
      };
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        const transient =
          err.code === 'ENOBUFS' || err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL';
        if (port === 0 && transient && attempt < LISTEN_RETRY_LIMIT) {
          const timer = setTimeout(
            () => {
              this.listenWithRetry(port, host, attempt + 1).then(resolve, reject);
            },
            LISTEN_RETRY_BASE_MS * (attempt + 1),
          );
          timer.unref?.();
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  /**
   * Stop the server. Resolves once the HTTP handle is fully closed, so a
   * caller (a test `afterEach`, a restart) cannot race its next bind against
   * sockets this server still owns.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.handler.close();
    this.transport.close();
    const server = this.httpServer;
    this.httpServer = null;
    if (!server) return;
    for (const socket of this.httpSockets) socket.destroy();
    this.httpSockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}

/**
 * Default per-turn implementation: a no-op that echoes nothing useful
 * and returns `end_turn`. Lets the server boot end-to-end without
 * needing the core Agent factory (which would couple this entrypoint
 * to a long-lived model provider). The real implementation is
 * `ACPServerAgentTurn` (follow-up PR) that wires a core `Agent`.
 */
const defaultEchoRunTurn: RunTurn = async (_input, _emit): Promise<RunTurnResult> => {
  return { stopReason: 'end_turn' };
};

/**
 * Constant-time credential comparison. A length mismatch short-circuits —
 * lengths are not secret — and equal-length inputs go through
 * `timingSafeEqual`, so the token cannot be recovered byte-by-byte from
 * response timing. Mirrors `tokenMatches` in the WebUI server.
 */
function timingSafeTokenEqual(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** True when the request's actual TCP peer is this machine. */
function isLoopbackPeer(req: { socket: { remoteAddress?: string | undefined } }): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/i, '');
  return address !== undefined && isLoopbackHost(address);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestPath(value: string | undefined): string {
  return value ?? '/';
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (normalized === 'localhost') return true;

  const literal =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  const version = isIP(literal);
  if (version === 4) return literal.startsWith('127.');
  if (version !== 6) return false;

  const groups = expandIPv6(literal);
  // biome-ignore lint/complexity/useOptionalChain: optional chain would make return type boolean|undefined, breaking the bool contract
  return groups !== null && groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;
}

/** Direct-module test seam; not re-exported by the package barrel. */
export const wrongStackACPServerCoverage = {
  defaultEchoRunTurn,
  headerValue,
  isLoopbackHost,
  requestPath,
};

/**
 * Bootstrap function for `node dist/agent/wrongstack-acp-agent.js`.
 * Instantiates the server with the default (no-op) runTurn so the
 * binary is useful as a connectivity smoke test.
 *
 * In practice the CLI will instantiate and run `WrongStackACPServer`
 * directly, passing a real `runTurn` wired to a core `Agent`.
 */
/* v8 ignore start -- process entrypoint: bootstrap + auto-start only run when launched as `node wrongstack-acp-agent.js`, never on import (which the CLI does to reuse the class). */
async function main(): Promise<void> {
  const server = new WrongStackACPServer();
  await server.start();
}

const isEntrypoint =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) {
  main().catch((err) => {
    writeErr(`[wstack-acp fatal] ${err}\n`);
    process.exit(1);
  });
}
/* v8 ignore stop */
