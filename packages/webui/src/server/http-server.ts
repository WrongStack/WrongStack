/**
 * Static-file HTTP server for the WebUI React frontend.
 *
 * - Serves files from `distDir` (typically `<webui>/dist`).
 * - Returns `index.html` for any unknown path so client-side routing works
 *   (SPA fallback) — and applies the same Content-Security-Policy to that
 *   fallback as to a direct `.html` response, so deep-linked routes are
 *   not unprotected.
 * - **Path-traversal guard**: `path.join` alone does NOT prevent
 *   `%2e%2e%2f` escapes (the `URL` constructor decodes percent-encoding
 *   before we see the path). We re-`resolve` the candidate and verify it
 *   stays under `distDir`.
 * - **CSP**: `connect-src` uses explicit loopback addresses for the WS
 *   server (not bare `ws:` / `wss:`) so a malicious page script cannot
 *   dial an attacker-controlled WebSocket. Combined with the
 *   cookie-based WS auth delivery (`/ws-auth` → `Set-Cookie: ws_token=
 *   …; HttpOnly; SameSite=Strict; Path=/`), this prevents cross-origin
 *   WS abuse.
 * - **API auth**: the `/api/sessions` and `/api/sessions/:id/agents`
 *   endpoints accept the same shared token as the WS upgrade, via the
 *   `X-WS-Token` header. Without it, those endpoints return 401. This
 *   closes the LAN-attacker enumeration vector when `wsHost` is
 *   non-loopback (e.g. `WS_HOST=0.0.0.0`).
 *
 * Extracted from `index.ts` so the static-serve concern can be tested
 * with a tiny fake `distDir` and asserted on path-traversal, MIME
 * matching, and CSP header presence.
 */
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import {
  handleApiFleetBroadcast,
  handleApiSessionAgents,
  handleApiSessionEvents,
  handleApiSessionInterrupt,
  handleApiSessionMailbox,
  handleApiSessionMessage,
  handleApiSessions,
} from './http-server/api-handlers.js';
import { isLoopbackBind, tokenMatches } from './ws-auth.js';
import type { FileWatcherMetrics } from './setup-events.js';

export interface CreateHttpServerOptions {
  /** Port to listen on. Defaults to 3456 (or the `PORT` env var). */
  port?: number | undefined;
  /** Host/interface to bind. Typically the loopback for the WebUI. */
  host: string;
  /** Resolved path to the directory containing the built React assets. */
  distDir: string;
  /**
   * WS port — appears in the CSP `connect-src` directive so the browser
   * is allowed to open a WebSocket back to the local server.
   */
  wsPort: number;
  /**
   * Path to the global WrongStack root (~/.wrongstack). Used by the
   * /api/sessions and /api/sessions/:id/agents endpoints to read the
   * cross-process SessionRegistry.
   */
  globalRoot?: string | undefined;
  /**
   * Shared auth token for `/api/*` endpoints. Required for non-loopback
   * binds (LAN exposure). Loopback binds accept any local origin without
   * a token (the WS path's loopback-bootstrap policy — see ws-auth.ts).
   */
  apiToken?: string | undefined;
  /**
   * If true, the `/ws-auth` endpoint exchanges a `?token=` query param (or
   * `X-WS-Token` header) for an `HttpOnly` auth cookie. The cookie is then
   * sent automatically on the WS upgrade, closing the C-598 query-string
   * token exposure class. Default: true. Set to false to keep the legacy
   * URL-token-only flow (e.g. in tests that don't want cookie state).
   */
  enableWsCookie?: boolean | undefined;
  /**
   * Optional file watcher metrics object. When provided, the
   * /debug/watcher-metrics endpoint will be enabled to expose these metrics.
   */
  watcherMetrics?: FileWatcherMetrics | undefined;
  /**
   * Push-on-write hook. `POST /api/fleet/ping` (loopback only) invokes this to
   * trigger an immediate fleet re-broadcast, so a TUI/REPL's registry write
   * reaches the map without waiting on the file-watch/poll. Best-effort.
   */
  onFleetPing?: (() => void) | undefined;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Inject the live WS port into the served HTML so the frontend connects to
 * THIS instance's backend instead of a hardcoded default. Enables running
 * several WebUI instances simultaneously on different PORT/WS_PORT pairs
 * (e.g. one per project) — each instance serves HTML stamped with its own
 * WS port.
 *
 * A `<meta>` tag is used deliberately rather than an inline `<script>`: the
 * CSP sets `script-src 'self'`, which would block an inline script, but meta
 * tags are not subject to script-src. The frontend reads
 * `meta[name="wrongstack-ws-port"]` (see ws-client.ts `defaultWsUrl`).
 */
export function injectWsPort(html: string, wsPort: number): string {
  const tag = `<meta name="wrongstack-ws-port" content="${wsPort}" />`;
  // Idempotent: never inject twice if the source HTML already carries one.
  if (html.includes('name="wrongstack-ws-port"')) return html;
  if (html.includes('</head>')) {
    return html.replace('</head>', `  ${tag}\n  </head>`);
  }
  // No <head> (unexpected) — prepend so the tag is still in the document.
  return `${tag}\n${html}`;
}

/** Build the Content-Security-Policy value for the given WS port. */
export function buildCspHeader(wsPort: number): string {
  return (
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ` +
    `connect-src 'self' ws://127.0.0.1:${wsPort} wss://127.0.0.1:${wsPort} ` +
    `ws://[::1]:${wsPort} wss://[::1]:${wsPort}; ` +
    `img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; ` +
    `base-uri 'self'; frame-ancestors 'none'; form-action 'self'`
  );
}

/**
 * Returns true when `candidate` (a fully-resolved absolute path) lies
 * strictly inside `distDir` (or equals it). Used to reject path-traversal
 * attempts after `path.resolve` has normalised any `..` segments.
 *
 * Exported so tests can assert the guard's contract without having to
 * also defeat the WHATWG URL normaliser (which strips `..` from the
 * path string *before* the request even reaches the server, making a
 * black-box test via fetch impossible).
 */
export function isInsideDist(candidate: string, distDir: string): boolean {
  const root = path.resolve(distDir);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Decode a `:id` path segment captured by the `/api/sessions/:id/*` routes.
 *
 * Session ids are `YYYY-MM-DD/HH-MM-SSZ_model_hash` — they contain a literal
 * `/`. The frontend builds the URL with `encodeURIComponent(sessionId)`, so
 * that slash arrives as `%2F`. The route regex `([^/]+)` correctly captures
 * the whole percent-encoded segment (there is no real `/` in `%2F`), but the
 * SessionRegistry is keyed by the *decoded* id — so the capture must be
 * `decodeURIComponent`d before lookup. Without this, every
 * `/api/sessions/:id/{events,message,agents}` request 404s (the registry has
 * `2026-…/…` but we looked up `2026-…%2F…`), which broke the Fleet HQ
 * watch-stream and the steer-message composer.
 *
 * Malformed percent-encoding (a lone `%`) makes `decodeURIComponent` throw;
 * fall back to the raw segment so the caller still gets a clean 404 rather
 * than a 500.
 */
export function decodeSessionId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Create the static-file HTTP server. Returns the `http.Server` (not
 * listening yet) so the caller can attach to a `shutdown()` hook and
 * coordinate the listen() with the WebSocket bootstrap.
 */
export function createHttpServer(opts: CreateHttpServerOptions): http.Server {
  const port = opts.port ?? Number.parseInt(process.env['PORT'] ?? '3456', 10);
  const distDir = path.resolve(opts.distDir);
  const wsPort = opts.wsPort;
  // Loopback bind: no API token required (mirrors WS loopback-bootstrap).
  // LAN bind: caller MUST supply a token; we reject any /api request that
  // doesn't present it via `X-WS-Token` (constant-time compared).
  const requireApiToken = !isLoopbackBind(opts.host) && Boolean(opts.apiToken);

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      // ── API routes ──────────────────────────────────────────────────
      // /ws-auth — exchange a one-shot token (header or query) for an
      // HttpOnly cookie. The browser then sends the cookie on the WS
      // upgrade automatically, closing C-598 (token-in-URL). Disabled
      // when `enableWsCookie: false` (tests, or operators who prefer
      // the URL-token flow for explicit dev).
      if (url.pathname === '/ws-auth' && req.method === 'GET' && (opts.enableWsCookie ?? true)) {
        // Accept the token from `?token=` query (browser navigation
        // from the server-printed URL) OR the `X-WS-Token` header
        // (scripted client).
        const provided =
          url.searchParams.get('token') ?? (req.headers['x-ws-token'] as string | undefined);
        if (!provided || !opts.apiToken || !tokenMatches(provided, opts.apiToken)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
        // HttpOnly + SameSite=Strict + Path=/ — the cookie is immune to
        // XSS exfiltration (no JS access), cross-origin Referer leakage
        // (Strict blocks cross-site), and is scoped to this origin only.
        // No `Secure` flag: the dev server is plain HTTP on loopback,
        // and a Secure cookie over HTTP would not be sent by the browser.
        res.writeHead(200, {
          'Content-Type': 'text/plain',
          'Set-Cookie': `ws_token=${encodeURIComponent(opts.apiToken)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`,
          // Belt-and-braces: tell any caches the cookie response itself
          // is sensitive.
          'Cache-Control': 'no-store',
        });
        res.end('ok');
        return;
      }

      // /api/fleet/ping — push-on-write nudge from a same-project TUI/REPL.
      // Triggers an immediate fleet re-broadcast of data the WS clients already
      // receive (no new disclosure, no persistent mutation). Same auth posture
      // as /api/sessions: open on loopback, token-gated on a LAN bind.
      if (url.pathname === '/api/fleet/ping' && req.method === 'POST') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        try {
          opts.onFleetPing?.();
        } catch {
          /* best-effort */
        }
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        // `req.headers['x-ws-token']` is typed as `string | string[] | undefined`
        // because some Node http clients send repeated headers as an array.
        // Pick the first value for the constant-time compare.
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiSessions(res, opts.globalRoot);
        return;
      }

      const agentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/agents$/);
      if (agentsMatch && req.method === 'GET') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiSessionAgents(res, opts.globalRoot, decodeSessionId(agentsMatch[1]!));
        return;
      }

      // /api/sessions/:id/events — replay another session's conversation +
      // tool stream (read-only) so the WebUI can *watch* a TUI/REPL running in
      // the same project. Reads that session's JSONL via the core session
      // reader; the browser re-fetches to tail it live.
      const eventsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/events$/);
      if (eventsMatch && req.method === 'GET') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
        const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
        await handleApiSessionEvents(res, opts.globalRoot, decodeSessionId(eventsMatch[1]!), limit);
        return;
      }

      // /api/sessions/:id/message — send a steering message into another
      // session's mailbox. Its running agent injects pending mailbox messages
      // before each LLM call, so this is two-way control: the WebUI steers a
      // TUI/REPL working in the same project. Loopback-open, token-gated on LAN.
      const msgMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
      if (msgMatch && req.method === 'POST') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiSessionMessage(res, req, opts.globalRoot, decodeSessionId(msgMatch[1]!));
        return;
      }

      // /api/sessions/:id/mailbox — the human<->leader thread (read-receipts +
      // replies). Makes the two-way loop visible in Fleet HQ.
      const mailboxMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/mailbox$/);
      if (mailboxMatch && req.method === 'GET') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiSessionMailbox(res, opts.globalRoot, decodeSessionId(mailboxMatch[1]!));
        return;
      }

      // /api/sessions/:id/interrupt — cooperative stop (control message).
      const interruptMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/interrupt$/);
      if (interruptMatch && req.method === 'POST') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiSessionInterrupt(
          res,
          req,
          opts.globalRoot,
          decodeSessionId(interruptMatch[1]!),
        );
        return;
      }

      // /api/fleet/broadcast — one message to every live session's leader.
      if (url.pathname === '/api/fleet/broadcast' && req.method === 'POST') {
        const headerToken = req.headers['x-ws-token'];
        const provided = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (requireApiToken && !tokenMatches(provided, opts.apiToken ?? '')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiFleetBroadcast(res, req, opts.globalRoot);
        return;
      }

      // Debug endpoint: /debug/watcher-metrics
      // Returns file watcher metrics as JSON. No auth required (localhost only by default).
      if (url.pathname === '/debug/watcher-metrics' && req.method === 'GET') {
        if (opts.watcherMetrics) {
          // Update computed fields before returning
          const avgDelay = opts.watcherMetrics.broadcastsSent > 0
            ? opts.watcherMetrics.totalDebounceDelayMs / opts.watcherMetrics.broadcastsSent
            : 0;
          const response = {
            ...opts.watcherMetrics,
            averageDebounceDelayMs: avgDelay,
            timestamp: Date.now(),
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File watcher metrics not available' }));
        }
        return;
      }

      let filePath: string;

      if (url.pathname === '/' || url.pathname === '') {
        filePath = path.join(distDir, 'index.html');
      } else if (url.pathname.startsWith('/assets/')) {
        filePath = path.join(distDir, url.pathname);
      } else if (url.pathname.startsWith('/')) {
        filePath = path.join(distDir, url.pathname);
      } else {
        filePath = path.join(distDir, 'index.html');
      }

      // Path traversal guard: the resolved path must stay inside distDir.
      // WHATWG URL leaves percent-encoding alone in `url.pathname` (it
      // does not decode `%2e%2e` to `..`), so percent-encoded escapes
      // are *not* a concern here — but unencoded `..` segments are
      // normalised by `path.resolve` and would walk the candidate up
      // out of distDir. `isInsideDist` catches that.
      const resolvedPath = path.resolve(filePath);
      if (!isInsideDist(resolvedPath, distDir)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const ext = path.extname(resolvedPath);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.setHeader('Content-Type', contentType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

      if (ext === '.html') {
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', buildCspHeader(wsPort));
        // Stamp the live WS port into the HTML so the frontend dials this
        // instance's backend (not the hardcoded default) — required for
        // running multiple WebUI instances on different ports.
        const html = await fs.readFile(resolvedPath, 'utf8');
        res.writeHead(200);
        res.end(injectWsPort(html, wsPort));
        return;
      }

      const fileContent = await fs.readFile(resolvedPath);
      res.writeHead(200);
      res.end(fileContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // SPA fallback: serve index.html so client-side routing still works.
        try {
          const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
            'Content-Security-Policy': buildCspHeader(wsPort),
          });
          res.end(injectWsPort(html, wsPort));
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      } else {
        res.writeHead(500);
        res.end('Server error');
      }
    }
  });
}
