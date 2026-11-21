import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo, isIP } from 'node:net';
import { toErrorMessage } from '@wrongstack/core/utils';
import { hasModernMetadata, objectRecord } from './modern-protocol.js';
import type { MCPServer, MCPServerLogger } from './server-dispatch.js';
import { HTTP_BODY_CAP } from './server-stdio.js';
// 4 MiB

export interface ServeHttpOptions {
  /** TCP port. 0 picks an ephemeral port (resolved in the handle). Default 0. */
  port?: number | undefined;
  /** Bind address. Default '127.0.0.1' (loopback only). */
  host?: string | undefined;
  /**
   * Bearer token required on every request (`Authorization: Bearer <token>`).
   * REQUIRED when binding to a non-loopback host — `serveHttp` refuses to
   * expose tools to the network without one.
   */
  token?: string | undefined;
  logger?: MCPServerLogger | undefined;
}

export interface ServeHttpHandle {
  port: number;
  host: string;
  url: string;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Run an `MCPServer` over HTTP: POST a single JSON-RPC request, get the JSON
 * response (notifications → 202 with no body). Reuses `handleMessage`, so the
 * protocol is identical to the stdio transport.
 *
 * Security: binds to loopback by default. Binding to any other host (e.g.
 * `0.0.0.0`) REQUIRES a `token` — otherwise this rejects, because it would
 * otherwise expose tool execution to the whole network unauthenticated.
 */
export function serveHttp(
  server: MCPServer,
  opts: ServeHttpOptions = {},
): Promise<ServeHttpHandle> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 0;
  const token = opts.token;
  const log = opts.logger;

  if (!isLoopbackHost(host) && !token) {
    return Promise.reject(
      new Error(
        `serveHttp: refusing to bind to non-loopback host "${host}" without a token — ` +
          'pass a token to expose tools to the network, or bind to 127.0.0.1.',
      ),
    );
  }

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(server, req, res, token, log, host);
  });

  return new Promise<ServeHttpHandle>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      const boundPort = (httpServer.address() as AddressInfo).port;
      const displayHost = host === '::1' ? '[::1]' : host;
      resolve({
        port: boundPort,
        host,
        url: `http://${displayHost}:${boundPort}/`,
        close: () =>
          new Promise<void>((res2) => {
            httpServer.close(() => res2());
          }),
      });
    });
  });
}

export async function handleHttpRequest(
  server: MCPServer,
  req: IncomingMessage,
  res: ServerResponse,
  token: string | undefined,
  log: MCPServerLogger | undefined,
  boundHost: string,
): Promise<void> {
  const send = (status: number, body: string, type = 'application/json') => {
    res.writeHead(status, {
      'content-type': type,
      // This endpoint executes tools. Nothing about it should be embedded,
      // sniffed into another type, or leak its URL onward.
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      // No CORS headers are ever emitted: a cross-origin reader must not be
      // able to see a response even if it manages to send the request.
    });
    res.end(body);
  };

  // WS-024: a browser on any site can reach a loopback port. Two guards run
  // before anything else, on every method:
  //
  //  - Origin. Browsers attach it to every cross-origin request and cannot
  //    forge it. A foreign origin is refused outright. A same-origin one is
  //    accepted; a missing one is accepted because non-browser MCP clients
  //    (the actual audience for this transport) never send it.
  //  - Host. Pinned to the bound authority so a DNS-rebinding name that
  //    resolves to 127.0.0.1 cannot be used to turn a foreign page into a
  //    same-origin one.
  if (!originIsAcceptable(req, boundHost)) {
    return send(403, JSON.stringify({ error: 'cross-origin forbidden' }));
  }
  if (!hostHeaderIsAcceptable(req, boundHost)) {
    return send(403, JSON.stringify({ error: 'untrusted host header' }));
  }

  // WS-024: the token check used to sit AFTER this branch, so `GET` on any
  // path answered 200 with the server identity to an unauthenticated caller.
  if (token && !bearerTokenMatches(req.headers.authorization, token)) {
    return send(401, JSON.stringify({ error: 'unauthorized' }));
  }

  // Health probe.
  if (req.method === 'GET') {
    return send(200, JSON.stringify({ status: 'ok', server: 'wrongstack-mcp' }));
  }
  if (req.method !== 'POST') {
    return send(405, JSON.stringify({ error: 'method not allowed' }));
  }
  // WS-024: `application/json` is not a CORS-simple content type, so requiring
  // it means a cross-origin POST must clear a preflight this server never
  // answers. Without it, a page could drive tool execution with a `text/plain`
  // form-style POST that no preflight ever gates.
  if (!isJsonContentType(req.headers['content-type'])) {
    return send(415, JSON.stringify({ error: 'content-type must be application/json' }));
  }

  // Raw chunks, decoded once at the end: a TCP chunk can end inside a
  // multi-byte character, and decoding each chunk on its own turned both
  // halves into U+FFFD — a tool argument like `"ş"` reached the handler as
  // `"��"`, with the JSON still valid and nothing reporting the damage.
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let aborted = false;
  req.on('data', (chunk: Buffer) => {
    if (aborted) return;
    bodyBytes += chunk.byteLength;
    chunks.push(chunk);
    if (bodyBytes > HTTP_BODY_CAP) {
      aborted = true;
      send(413, JSON.stringify({ error: 'payload too large' }));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (aborted) return;
    const body = Buffer.concat(chunks, bodyBytes).toString('utf8');
    void (async () => {
      let message: Record<string, unknown> | undefined;
      try {
        message = objectRecord(JSON.parse(body));
      } catch {
        /* The core owns parse errors. */
      }
      const modern =
        hasModernMetadata(message?.['params']) ||
        (typeof req.headers['mcp-protocol-version'] === 'string' &&
          req.headers['mcp-protocol-version'] >= '2026-07-28');
      const validEnvelope =
        message !== undefined &&
        message['jsonrpc'] === '2.0' &&
        typeof message['method'] === 'string' &&
        (message['id'] === undefined ||
          message['id'] === null ||
          typeof message['id'] === 'string' ||
          typeof message['id'] === 'number');
      if (modern && validEnvelope && message) {
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          await server.validateHttpHeaders(message['method'] as string, message['params'], headers);
        } catch (error) {
          send(
            400,
            JSON.stringify({
              jsonrpc: '2.0',
              id: message?.['id'] ?? null,
              error: { code: -32020, message: toErrorMessage(error) },
            }),
          );
          return undefined;
        }
      }
      const controller = new AbortController();
      const abort = () => {
        if (!res.writableEnded) controller.abort();
      };
      if (modern) res.once('close', abort);
      try {
        const out = await server.handleMessage(
          body,
          modern ? { signal: controller.signal } : undefined,
        );
        if (res.destroyed) return undefined;
        if (modern && out) {
          const error = objectRecord(JSON.parse(out))?.['error'];
          const code = objectRecord(error)?.['code'];
          if (code === -32022 || code === -32020) {
            send(400, out);
            return undefined;
          }
          if (code === -32601) {
            send(404, out);
            return undefined;
          }
        }
        return out;
      } finally {
        res.removeListener('close', abort);
      }
    })()
      .then((out) => {
        if (out === undefined) return;
        // Notifications produce no response body.
        if (out === null) return send(202, '');
        return send(200, out);
      })
      .catch((err) => {
        log?.warn?.(`MCP http handler error: ${toErrorMessage(err)}`);
        if (!res.destroyed && !res.headersSent && !res.writableEnded) {
          send(500, JSON.stringify({ error: 'internal error' }));
        }
      });
  });
}

// ── WS-024: transport guards ───────────────────────────────────────────────

/** Hostnames that always denote this machine, regardless of the bind address. */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  // Only an IPv4 LITERAL in 127/8 is loopback. A bare `startsWith('127.')`
  // also admitted names such as `127.attacker.example`, which an attacker can
  // rebind to 127.0.0.1 — the exact DNS-rebinding case this guard exists for.
  return bare === 'localhost' || bare === '::1' || (isIP(bare) === 4 && bare.startsWith('127.'));
}

/**
 * Reject a request whose `Origin` names a site other than this server.
 *
 * A missing `Origin` is accepted: the clients this transport exists for
 * (Claude Desktop, IDE extensions, `curl`) are not browsers and never send
 * one. A browser, which is the threat here, always attaches it on a
 * cross-origin request and cannot forge it.
 */
export function originIsAcceptable(req: IncomingMessage, boundHost: string): boolean {
  const origin = req.headers.origin;
  if (origin === undefined || origin === 'null') return origin === undefined;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const rawHost = req.headers.host?.trim();
  if (!rawHost) return false;
  try {
    // Same-origin means the Origin's authority equals the one the request was
    // actually addressed to — which `hostHeaderIsAcceptable` separately pins
    // to the bind address, so the two together leave no gap.
    const requestAuthority = new URL(`${parsed.protocol}//${rawHost}`).host.toLowerCase();
    if (parsed.host.toLowerCase() !== requestAuthority) return false;
  } catch {
    return false;
  }
  // A loopback bind is only ever addressable as this machine.
  return isLoopbackHost(boundHost) ? isLoopbackHostname(parsed.hostname) : true;
}

/**
 * Pin the `Host` header to the bound address. Without this, an attacker
 * registers `evil.example → 127.0.0.1`, gets a victim's browser to load a page
 * there, and every request is same-origin by the browser's reckoning while
 * landing on this server (DNS rebinding).
 */
export function hostHeaderIsAcceptable(req: IncomingMessage, boundHost: string): boolean {
  const rawHost = req.headers.host?.trim();
  if (!rawHost) return false;
  let parsed: URL;
  try {
    parsed = new URL(`http://${rawHost}`);
  } catch {
    return false;
  }
  // A bare authority only — userinfo, a path, or a query means something is
  // trying to smuggle structure through the header.
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search) return false;
  if (isLoopbackHost(boundHost)) return isLoopbackHostname(parsed.hostname);
  // A non-loopback bind is an explicit operator decision and requires a token
  // (see `serveHttp`), so the hostname is theirs to choose.
  return true;
}

/** `application/json`, with or without parameters such as `; charset=utf-8`. */
export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const base = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return base === 'application/json' || base.endsWith('+json');
}

/**
 * Constant-time bearer comparison. `auth !== expected` short-circuits on the
 * first differing byte, which leaks the token prefix to a caller that can time
 * responses — and a local attacker can time them very precisely.
 */
export function bearerTokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const supplied = Buffer.from(header ?? '');
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}
