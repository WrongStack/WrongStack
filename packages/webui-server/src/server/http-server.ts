/**
 * Static-file HTTP server for the WebUI / SimpleUI React frontends.
 *
 * Design:
 * - **Single port — shared HTTP + WebSocket.** A single port serves both the
 *   static frontend and the WebSocket protocol. See the port-utils module.
 * - **CSP**: `connect-src 'self'` covers the core same-origin case. For loopback
 *   binds (127.0.0.1 / localhost) we also add explicit `ws://`/`wss://` entries
 *   so browsers that strictly separate `ws:` from `http:` in CSP `connect-src`
 *   matching still allow WS upgrades. These loopback entries are safe because
 *   they only open connections to the local machine. Tunnel/proxy setups use
 *   `publicWsUrl` for the single external origin.
 * - **Path-traversal guard**: `path.join` alone does NOT prevent
 *   `%2e%2e%2f` escapes (the `URL` constructor decodes percent-encoding
 *   before we see the path). We re-`resolve` the candidate and verify it
 *   stays under `distDir`.
 * - **Access auth**: on non-loopback binds, all HTTP routes require the same
 *   shared token as the WS upgrade, accepted via `?token=...`, `X-WS-Token`,
 *   or the `ws_token` HttpOnly cookie. This protects the React UI and the
 *   `/api/*` control/read endpoints when `WS_HOST=0.0.0.0`.
 *
 * Extracted from `index.ts` so the static-serve concern can be tested
 * with a tiny fake `distDir` and asserted on path-traversal, MIME
 * matching, and CSP header presence.
 */
import * as http from 'node:http';
import * as path from 'node:path';
import { generateProjectSlug } from './projects-manifest.js';
import type { FileWatcherMetrics } from './setup-events.js';
import type { TechStackEvent } from './techstack-handlers.js';
import { httpRequestOriginOk, isLoopbackBind, tokenMatches } from './ws-auth.js';
import { handleApiRoutes } from './http-server/api-router.js';
import { handleSpaFallback, handleStaticFileRequest } from './http-server/static-file-handler.js';
import {
  buildCspHeader,
  decodeSessionId,
  injectWsConfig,
  isInsideDist,
  requestToken,
  setAuthCookieHeaders,
  WS_TOKEN_COOKIE,
  WS_TOKEN_COOKIE_SECURE,
} from './http-server/security-helpers.js';

export {
  buildCspHeader,
  decodeSessionId,
  injectWsConfig,
  isInsideDist,
  requestToken,
  WS_TOKEN_COOKIE,
  WS_TOKEN_COOKIE_SECURE,
};

export interface CreateHttpServerOptions {
  /** Port to listen on. Defaults to 3456 (or the `PORT` env var). */
  port?: number | undefined;
  /** Host/interface to bind. Typically the loopback for the WebUI. */
  host: string;
  /** Resolved path to the directory containing the built React assets. */
  distDir: string;
  /**
   * Public WebSocket URL injected into the frontend. Use this behind tunnels or
   * reverse proxies where the browser-facing WS URL differs from host:wsPort.
   */
  publicWsUrl?: string | undefined;
  /**
   * Path to the global WrongStack root (~/.wrongstack). Used by the
   * /api/sessions and /api/sessions/:id/agents endpoints to read the
   * cross-process SessionRegistry.
   */
  globalRoot?: string | undefined;
  /**
   * Shared auth token for HTTP and WS access. Required for non-loopback
   * binds (LAN exposure). Loopback binds accept local browser access without
   * a token (the WS path's loopback-bootstrap policy — see ws-auth.ts).
   */
  apiToken?: string | undefined;
  /** Force HTTP token auth even on loopback binds, useful behind public tunnels. */
  requireToken?: boolean | undefined;
  /**
   * Extra `Host`/`Origin` hostnames accepted by the CSRF/rebinding guard, for
   * operators fronting the WebUI with a tunnel or reverse proxy. The hostname
   * of `publicWsUrl` is trusted implicitly. Mirrors the WS path's
   * `allowedHostnames` (see ws-auth.ts).
   */
  allowedHostnames?: readonly string[] | undefined;
  /**
   * If true, the `/ws-auth` endpoint exchanges a `?token=` query param (or
   * `X-WS-Token` header) for an `HttpOnly` auth cookie. The cookie is then
   * sent automatically on the WS upgrade, closing the C-598 query-string
   * token exposure class. Default: true. Set to false to keep the legacy
   * URL-token-only flow (e.g. in tests that don't want cookie state).
   */
  enableWsCookie?: boolean | undefined;
  /**
   * Mark the `ws_token` cookie `Secure` and give it the `__Host-` prefix.
   *
   * Inferred from a `wss://` {@link CreateHttpServerOptions.publicWsUrl} when
   * omitted, which covers the tunnel deployments this server documents. Set it
   * explicitly when TLS is terminated in front of the server by something that
   * does not surface through `publicWsUrl` (e.g. an nginx `proxy_pass` with a
   * separately configured WS origin).
   *
   * Must stay false on a plain-HTTP loopback bind: browsers do not send a
   * `Secure` cookie over HTTP, so enabling it there breaks the WS handshake.
   */
  secureCookies?: boolean | undefined;
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
  /**
   * Project root path for the codebase index. When provided, the
   * /api/codemap/* endpoints serve the dependency graph.
   */
  projectRoot?: string | undefined;
  /** Optional codebase-index directory override (tests). */
  indexDir?: string | undefined;
  /** Project-wide TechStack events projected onto the WebSocket transport. */
  onTechStackEvent?: ((event: TechStackEvent) => void) | undefined;
  /**
   * Live provider access for TechStack's LLM research stage. Omit it and
   * `analyze` stays deterministic (registry + advisories only).
   *
   * A getter, not a value — see `TechStackHandlerDeps.getLlm`.
   */
  getLlm?:
    | (() => { provider: import('@wrongstack/core/types').Provider; model: string } | undefined)
    | undefined;
  /** Permission-governed language_package bridge for approved remediation. */
  executePackageOperation?: import('./techstack-handlers.js').TechStackHandlerDeps['executePackageOperation'];
  /**
   * Optional Requirements Intake service. When provided, the
   * /api/projects/:projectId/requirement-intakes and
   * /api/requirement-intakes/:intakeId endpoints are enabled; otherwise they
   * respond 503.
   */
  intakeService?: import('@wrongstack/requirement-intake').RequirementIntakeService | undefined;
  /**
   * Optional vector-memory store. When provided, the four
   * `/api/vector-memory/{status,search,store,store/:id}` endpoints become
   * active and return live data. When omitted, the route responds with
   * `{ enabled: false }` (status) or 503 (search/store/forget), so a
   * non-CLI webui-server host stays on its existing surface with zero
   * behavior change.
   */
  getVectorMemoryStore?:
    | (() => import('@wrongstack/vector-memory').VectorMemoryStore | undefined)
    | undefined;
  /** Model cache directory for the vector-memory provider. */
  vectorMemoryModelCacheDir?: string | undefined;
}

/**
 * Create the static-file HTTP server. Returns the `http.Server` (not
 * listening yet) so the caller can attach to a `shutdown()` hook and
 * coordinate the listen() with the WebSocket bootstrap.
 */
export function createHttpServer(opts: CreateHttpServerOptions): http.Server {
  const port = opts.port ?? Number.parseInt(process.env['PORT'] ?? '3456', 10);
  const distDir = path.resolve(opts.distDir);
  const requireAccessToken = Boolean(opts.requireToken) || !isLoopbackBind(opts.host);
  const secureCookies =
    opts.secureCookies ?? opts.publicWsUrl?.trim().toLowerCase().startsWith('wss:') ?? false;
  const trustedHostnames: readonly string[] = (() => {
    const names = [...(opts.allowedHostnames ?? [])];
    if (opts.publicWsUrl) {
      try {
        names.push(new URL(opts.publicWsUrl).hostname);
      } catch {
        /* malformed public URL contributes no trust */
      }
    }
    return names;
  })();
  let techStackRuntime: Promise<{
    store: import('@wrongstack/techstack').TechStackStore;
    engine: import('@wrongstack/techstack').TechStackEngine;
    runningJobs: Map<string, AbortController>;
  }> | null = null;
  const getTechStackRuntime = async () => {
    if (!opts.projectRoot) throw new Error('Project root not configured');
    techStackRuntime ??= import('@wrongstack/techstack').then(
      ({ TechStackEngine, TechStackStore }) => {
        const store = new TechStackStore({ projectSlug: generateProjectSlug(opts.projectRoot!) });
        return { store, engine: new TechStackEngine(store), runningJobs: new Map() };
      },
    );
    return techStackRuntime;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      // ── CSRF / DNS-rebinding boundary (WS-001) ──────────────────────
      // Runs before any routing, mirroring the HQ server's guard at
      // hq-server/routes.ts:179. Without it a `text/plain` POST from any
      // website the user is browsing reaches /api/* as a CORS simple
      // request — no preflight, no token on the loopback default.
      if (
        !httpRequestOriginOk({
          origin: req.headers.origin,
          hostHeader: req.headers.host,
          wsHost: opts.host,
          allowedHostnames: trustedHostnames,
        })
      ) {
        res.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'forbidden: untrusted request origin' }));
        return;
      }

      const providedAccessToken = requestToken(req, url, { allowQuery: true });
      const accessTokenOk =
        Boolean(opts.apiToken) && tokenMatches(providedAccessToken, opts.apiToken ?? '');
      const shouldSetAuthCookie =
        Boolean(opts.apiToken) &&
        tokenMatches(url.searchParams.get('token') ?? undefined, opts.apiToken ?? '');

      // ── API routes ──────────────────────────────────────────────────
      if (url.pathname === '/ws-auth' && req.method === 'GET' && (opts.enableWsCookie ?? true)) {
        const provided = requestToken(req, url, { allowQuery: true });
        if (!provided || !opts.apiToken || !tokenMatches(provided, opts.apiToken)) {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized');
          return;
        }
        setAuthCookieHeaders(res, opts.apiToken, secureCookies);
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      if (requireAccessToken && !accessTokenOk) {
        res.writeHead(401, {
          'Content-Type': 'text/plain',
          'Cache-Control': 'no-store',
        });
        res.end('Unauthorized');
        return;
      }

      // ── Origin-less mutation gate (the HTTP half of WS-005) ─────────
      const isMutatingApiRequest =
        url.pathname.startsWith('/api/') &&
        (req.method === 'POST' ||
          req.method === 'PUT' ||
          req.method === 'PATCH' ||
          req.method === 'DELETE');
      if (isMutatingApiRequest && !req.headers.origin && !accessTokenOk) {
        res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(
          JSON.stringify({
            error:
              'Unauthorized: a request without an Origin header must present the access token (X-WS-Token header or ws_token cookie).',
          }),
        );
        return;
      }

      if (shouldSetAuthCookie && opts.apiToken) {
        setAuthCookieHeaders(res, opts.apiToken, secureCookies);
      }

      const handled = await handleApiRoutes(
        req,
        res,
        url,
        opts,
        requireAccessToken,
        accessTokenOk,
        getTechStackRuntime,
      );
      if (handled) return;

      await handleStaticFileRequest(
        req,
        res,
        distDir,
        url,
        opts,
        // Live port from the socket: the bind may have advanced past an
        // EADDRINUSE (listenWithRetry) after this server was constructed,
        // and the CSP must advertise the port actually serving this request.
        res.socket?.localPort ?? port,
        shouldSetAuthCookie,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        await handleSpaFallback(res, distDir, opts, res.socket?.localPort ?? port);
      } else {
        console.error({ url: req.url, err });
        res.writeHead(500);
        res.end('Server error');
      }
    }
  });

  server.once('close', () => {
    void techStackRuntime
      ?.then(({ store, runningJobs }) => {
        for (const controller of runningJobs.values()) controller.abort();
        runningJobs.clear();
        store.close();
      })
      .catch(() => undefined);
  });
  return server;
}
