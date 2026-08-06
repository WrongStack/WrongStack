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
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import * as v8 from 'node:v8';
import { sanitizeApiError } from '@wrongstack/core/security';
import { getIndexState } from '@wrongstack/tools';
import { handleDeadCodeScan, handleDeadCodeActionPlan } from './deadcode-handlers.js';
import {
  handleCodemapFiles,
  handleCodemapPackages,
  handleCodemapSymbols,
} from './codemap-handlers.js';
import {
  handleApiAnalyticsGet,
  handleApiAnalyticsPost,
  handleApiAnalyticsSummary,
} from './http-server/analytics-handler.js';
import {
  handleApiFleetBroadcast,
  handleApiSessionAgents,
  handleApiSessionEvents,
  handleApiSessionInterrupt,
  handleApiSessionMailbox,
  handleApiSessionMessage,
  handleApiSessions,
} from './http-server/api-handlers.js';
import {
  handleRequirementIntakeAnswers,
  handleRequirementIntakeArchive,
  handleRequirementIntakeCancel,
  handleRequirementIntakeCreate,
  handleRequirementIntakeGet,
  handleRequirementIntakeList,
  handleRequirementIntakeListForServer,
  handleRequirementIntakeSubmit,
  handleRequirementIntakeSuggestions,
  handleRequirementIntakeUpdate,
} from './requirement-intake-handlers.js';
import { readRecentProcessMemoryDiagnostics } from './memory-diagnostics.js';
import { generateProjectSlug } from './projects-manifest.js';
import type { FileWatcherMetrics } from './setup-events.js';
import {
  handleTechStackAnalyze,
  handleTechStackCancel,
  handleTechStackDependencyResearch,
  handleTechStackInventory,
  handleTechStackJobStatus,
  handleTechStackRemediationApply,
  handleTechStackRemediationPlan,
  handleTechStackReport,
  handleTechStackSnapshot,
  handleTechStackTrends,
  type TechStackEvent,
} from './techstack-handlers.js';
import {
  extractTokenFromCookie,
  httpRequestOriginOk,
  isLoopbackHostname,
  tokenMatches,
} from './ws-auth.js';

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

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function injectWsConfig(html: string, opts: { publicWsUrl?: string | undefined }): string {
  // The WebSocket now shares the HTTP server port, so the frontend derives
  // the WS URL from the page origin. No wrongstack-ws-port meta tag needed.
  const out = html;
  if (!opts.publicWsUrl || out.includes('name="wrongstack-ws-url"')) return out;
  const tag = `<meta name="wrongstack-ws-url" content="${escapeHtmlAttr(opts.publicWsUrl)}" />`;
  if (out.includes('</head>')) {
    return out.replace('</head>', `  ${tag}\n  </head>`);
  }
  return `${tag}\n${out}`;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * WS-107: the auth cookie never carried `Secure`, on the stated grounds that
 * "the dev server is plain HTTP on loopback". True for the default bind — and
 * wrong for the deployment this server explicitly supports, where a tunnel
 * terminates TLS in front of it (`publicWsUrl: wss://…`). There the browser is
 * on HTTPS, so a cookie set without `Secure` is one the browser will also
 * attach to a plaintext request to the same host: a downgrade or a stray
 * `http://` link leaks the token that authenticates the whole control plane.
 *
 * So the flag follows the deployment. On an HTTPS-fronted server the cookie is
 * additionally `__Host-`-prefixed, which browsers only accept when it is
 * Secure, Path=/, and Domain-less — the same hardening the HQ server adopted.
 * On loopback HTTP neither is usable (a `Secure` cookie would simply not be
 * sent), so the plain name is kept there.
 */
export const WS_TOKEN_COOKIE = 'ws_token';
export const WS_TOKEN_COOKIE_SECURE = '__Host-ws_token';

function wsTokenCookie(token: string, secure: boolean): string {
  const name = secure ? WS_TOKEN_COOKIE_SECURE : WS_TOKEN_COOKIE;
  const parts = [
    `${name}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=3600',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function setAuthCookieHeaders(res: http.ServerResponse, token: string, secure: boolean): void {
  res.setHeader('Set-Cookie', wsTokenCookie(token, secure));
  res.setHeader('Cache-Control', 'no-store');
}

function setStaticSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Resolve the access token presented on an HTTP request.
 *
 * WS-108: the `?token=` query source was accepted on EVERY route regardless of
 * bind. On a tunnel that is the C-598 exposure the WS path already closed —
 * the token reaches reverse-proxy access logs, browser history, and any
 * `Referer` the page emits to a third-party origin. The header and cookie
 * sources have none of those channels.
 *
 * `allowQuery` is therefore opt-in and reserved for the two places the token
 * legitimately rides the URL: `/ws-auth`, whose entire job is to exchange it
 * for the cookie, and the HTML page load the operator opens from the printed
 * access URL. Everywhere else it is refused off-loopback — and when refused,
 * resolution falls through to the header and cookie rather than returning
 * early, so a client that sent both still authenticates.
 */
export function requestToken(
  req: http.IncomingMessage,
  url: URL,
  opts: { allowQuery?: boolean } = {},
): string | undefined {
  const queryToken = url.searchParams.get('token') ?? undefined;
  if (queryToken !== undefined && (opts.allowQuery === true || isLoopbackPeer(req))) {
    return queryToken;
  }
  return firstHeader(req.headers['x-ws-token']) ?? extractTokenFromCookie(req.headers.cookie);
}

/** True when the request's actual TCP peer is this machine. */
function isLoopbackPeer(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress?.replace(/^::ffff:/i, '');
  return address !== undefined && isLoopbackHostname(address);
}

function formatCspHostname(hostname: string): string {
  return hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
}

function cspSourceFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined;
    return `${url.protocol}//${formatCspHostname(url.hostname)}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return undefined;
  }
}

/**
 * Extra `script-src` sources beyond `'self'`.
 *
 * The WrongStack frontend is a Vite build that ships **zero** inline scripts —
 * every script is an external `.js` file covered by `'self'`. The app itself
 * needs no `'unsafe-inline'`.
 *
 * `'wasm-unsafe-eval'` is required for `shiki` (used by `rehype-pretty-code`
 * for code-block syntax highlighting in chat messages) — its oniguruma
 * grammar engine is compiled to WebAssembly. Without this source, every
 * markdown render that encounters a code block throws:
 *   `CompileError: call to WebAssembly.instantiate() blocked by CSP`
 *   `Error: \`runSync\` finished async. Use \`run\` instead`
 *
 * WS-061: `'unsafe-inline'` was here too, and it is not coming back. Its stated
 * purpose was suppressing browser-extension console noise — extensions
 * page-inject an inline bootstrap, which trips a `content.js:…` CSP violation.
 * That is the extension's injection being blocked, which is the policy working;
 * it never affected the app.
 *
 * The trade was backwards. `'unsafe-inline'` disables the entire inline-script
 * defence for every visitor in order to quiet one developer's console, and it
 * is strictly broader than the per-extension `'sha256-…'` allowlist that this
 * project already considered and rejected on 2026-07-15 (a treadmill of hashes
 * that change on every extension update). Rejecting the narrow workaround and
 * then shipping the wide one is the worst of both.
 *
 * Verified before removal rather than assumed: the Vite builds for webui,
 * simpleui and webui-hq contain ZERO inline `<script>` elements without `src`,
 * so nothing this server serves needs the source. If that ever changes, the
 * answer is a nonce or a hash for that specific script — not this keyword.
 */
const EXTRA_SCRIPT_SOURCES: readonly string[] = ["'wasm-unsafe-eval'"];

/**
 * Build the Content-Security-Policy value for the WebUI.
 *
 * Adds explicit `ws://`/`wss://` entries for loopback addresses (`127.0.0.1`,
 * `localhost`) so `connect-src` covers WebSocket even in strict CSP
 * implementations that distinguish `ws:` from `http:` origins.
 *
 * @param publicWsUrl - Optional public-facing WS URL (tunnel/reverse-proxy).
 *   When set, this origin is added to `connect-src` as a `ws://`/`wss://` entry.
 * @param host - The server bind host. When it matches a known loopback address
 *   (`127.0.0.1`, `::1`, `[::1]`, or `localhost`), explicit `ws://`/`wss://`
 *   entries for `127.0.0.1` and `localhost` are added to `connect-src`.
 *   IPv6 loopback (`[::1]`) is excluded — it produces an invalid CSP source
 *   and is covered by `'self'` (CSP maps ws:→http:, wss:→https:).
 * @param port - The server listen port. Defaults to `3456`. Unnecessary when
 *   only publicWsUrl is used (no loopback branch).
 */
export function buildCspHeader(
  publicWsUrl?: string | undefined,
  host?: string,
  port?: number,
): string {
  const connect = new Set(["'self'"]);
  const publicWsSource = publicWsUrl ? cspSourceFromUrl(publicWsUrl) : undefined;
  if (publicWsSource) connect.add(publicWsSource);
  // Explicit WS origins for loopback binds — some CSP implementations do not
  // equate `ws:`/`wss:` with `http:`/`https:` for the `'self'` keyword in
  // connect-src. Adding the canonical loopback hostnames covers access via
  // 127.0.0.1 and localhost regardless of which interface the server is
  // actually bound to (prevents drift from the ws-auth.ts policy).
  //
  // IPv6 loopback (`[::1]`) is intentionally excluded: the CSP host-source
  // grammar (host-char = ALPHA / DIGIT / "-") does not permit square brackets,
  // so `ws://[::1]:PORT` is an invalid source that browsers silently ignore.
  // Same-origin WS connections to an IPv6 loopback are covered by `'self'`,
  // which CSP maps ws:→http: / wss:→https: (CSP Level 3 §6.4.2.1).
  if (host && isLoopbackHostname(host)) {
    const p = port ?? 3456;
    // Guard against config typos (negative, zero, or impossibly large port).
    // This is NOT about ephemeral-port binds (listen(0)) — createHttpServer
    // resolves the real port from server.address() and passes it here.
    if (p > 0 && p <= 65535) {
      for (const h of ['127.0.0.1', 'localhost']) {
        connect.add(`ws://${h}:${p}`);
        connect.add(`wss://${h}:${p}`);
      }
    }
  }
  const scriptSrc = ["'self'", ...EXTRA_SCRIPT_SOURCES].join(' ');
  return (
    `default-src 'self'; script-src ${scriptSrc}; style-src 'self' 'unsafe-inline'; ` +
    `connect-src ${Array.from(connect).join(' ')}; ` +
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
 * Session ids are `YYYY-MM-DD/sess_<ULID>` — they contain a literal
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
 * Decode a URI-encoded path segment and return 400 on failure.
 * Use this when the caller should not silently accept malformed input.
 */
function strictDecodeParam(segment: string, res: http.ServerResponse): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URI encoding in path parameter' }));
    return null;
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
  // Security scan 2026-08-04, finding H3. This used to read
  // `Boolean(opts.requireToken) || !isLoopbackBind(opts.host)`, so on the
  // DEFAULT loopback bind it was false and every downstream
  // `requireAccessToken && !accessTokenOk` gate below became a no-op. Any
  // process on the machine could enumerate and read every session transcript
  // and `POST /api/sessions/:id/message` into a running agent.
  //
  // The comment justifying it said "mirrors WS loopback-bootstrap" — but
  // WS-005 had already concluded that reaching loopback is not authentication
  // and required a token there. The two surfaces sit on the same port and had
  // opposite answers; this is the HTTP side catching up.
  //
  // Costs a legitimate client nothing: a token always exists
  // (`resolveAuthToken` generates one), the browser exchanges it for the
  // `ws_token` cookie at `/ws-auth` and `requestToken` accepts that cookie, and
  // the one non-browser caller (`FleetNotifier` → `POST /api/fleet/ping`) now
  // reads the token from the instance registry and sends `x-ws-token`.
  //
  // Scope note: this authenticates the *channel*. A process running as the same
  // user can still read the token from `~/.wrongstack` — and could read the
  // session files directly without the API at all. What it stops is an
  // unprivileged or differently-scoped local process reaching the control plane.
  const requireAccessToken = true;
  // WS-107: `Secure` (and the `__Host-` prefix) follow the deployment. An
  // operator-supplied `wss://` public URL means a TLS terminator sits in front
  // of this server, so the browser is on HTTPS even though this socket is not.
  const secureCookies =
    opts.secureCookies ?? (opts.publicWsUrl?.trim().toLowerCase().startsWith('wss:') ?? false);
  // Hostnames the CSRF/DNS-rebinding guard accepts beyond loopback: whatever the
  // operator registered, plus the tunnel hostname implied by `publicWsUrl`.
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

      // `allowQuery` for the HTML page load — the second of the two places
      // `requestToken`'s own doc reserves for a URL token, and the one it was
      // never actually granted. Off-loopback the query token was therefore
      // discarded, resolution fell through to a header/cookie a first-time
      // browser does not have, and the 401 below fired BEFORE the cookie-seed
      // at the bottom of this block could run — so the very URL this server
      // prints for a wildcard bind (`▸ Tailscale: http://100.x.y.z:3456/?token=…`)
      // could never work. `shouldSetAuthCookie` was already reading the raw
      // query param for exactly this flow; the gate above it just refused first.
      const providedAccessToken = requestToken(req, url, { allowQuery: true });
      const accessTokenOk =
        Boolean(opts.apiToken) && tokenMatches(providedAccessToken, opts.apiToken ?? '');
      // The page load from the operator's printed access URL is the one place a
      // query token is expected outside /ws-auth — it is what seeds the cookie.
      const shouldSetAuthCookie =
        Boolean(opts.apiToken) &&
        tokenMatches(url.searchParams.get('token') ?? undefined, opts.apiToken ?? '');

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
        const provided = requestToken(req, url, { allowQuery: true });
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

      if (shouldSetAuthCookie && opts.apiToken) {
        setAuthCookieHeaders(res, opts.apiToken, secureCookies);
      }

      // /api/fleet/ping — push-on-write nudge from a same-project TUI/REPL.
      // Triggers an immediate fleet re-broadcast of data the WS clients already
      // receive (no new disclosure, no persistent mutation). Same auth posture
      // as /api/sessions: open on loopback, token-gated on a LAN bind.
      if (url.pathname === '/api/fleet/ping' && req.method === 'POST') {
        if (requireAccessToken && !accessTokenOk) {
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
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiSessions(res, opts.globalRoot);
        return;
      }

      const agentsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/agents$/);
      if (agentsMatch && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
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
        if (requireAccessToken && !accessTokenOk) {
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
        if (requireAccessToken && !accessTokenOk) {
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
        if (requireAccessToken && !accessTokenOk) {
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
        if (requireAccessToken && !accessTokenOk) {
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
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiFleetBroadcast(res, req, opts.globalRoot);
        return;
      }

      // /api/analytics — ingest frontend analytics events.
      // POST: accept a batch of events. GET: retrieve recent events.
      // GET /api/analytics/summary: aggregated stats.
      if (url.pathname === '/api/analytics' && req.method === 'POST') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiAnalyticsPost(res, req);
        return;
      }
      if (url.pathname === '/api/analytics' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiAnalyticsGet(res, url);
        return;
      }
      if (url.pathname === '/api/analytics/summary' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleApiAnalyticsSummary(res);
        return;
      }

      // ── Requirements Intake endpoints ──────────────────────────────────
      // Project-scoped collection + per-record operations. Same token gate as
      // every other /api route; the service instance is optional (503 when the
      // host did not wire one). The bare GET /api/requirement-intakes lists the
      // server's own project (identity resolved from projectRoot).
      if (url.pathname === '/api/requirement-intakes' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleRequirementIntakeListForServer(res, opts.intakeService, opts.projectRoot);
        return;
      }

      const intakeProjectMatch = url.pathname.match(
        /^\/api\/projects\/([^/]+)\/requirement-intakes$/,
      );
      if (intakeProjectMatch && req.method === 'POST') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleRequirementIntakeCreate(
          res,
          req,
          opts.intakeService,
          decodeURIComponent(intakeProjectMatch[1]!),
        );
        return;
      }
      if (intakeProjectMatch && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleRequirementIntakeList(
          res,
          opts.intakeService,
          decodeURIComponent(intakeProjectMatch[1]!),
        );
        return;
      }

      const intakeIdMatch = url.pathname.match(/^\/api\/requirement-intakes\/([^/]+)$/);
      if (intakeIdMatch && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleRequirementIntakeGet(res, opts.intakeService, intakeIdMatch[1]!);
        return;
      }
      if (intakeIdMatch && req.method === 'PATCH') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        await handleRequirementIntakeUpdate(res, req, opts.intakeService, intakeIdMatch[1]!);
        return;
      }

      const intakeActionMatch = url.pathname.match(
        /^\/api\/requirement-intakes\/([^/]+)\/(answers|suggestions|submit|cancel|archive)$/,
      );
      if (intakeActionMatch && req.method === 'POST') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        const intakeId = intakeActionMatch[1]!;
        const action = intakeActionMatch[2]!;
        if (action === 'answers') {
          await handleRequirementIntakeAnswers(res, req, opts.intakeService, intakeId);
        } else if (action === 'suggestions') {
          await handleRequirementIntakeSuggestions(res, req, opts.intakeService, intakeId);
        } else if (action === 'submit') {
          await handleRequirementIntakeSubmit(res, opts.intakeService, intakeId);
        } else if (action === 'cancel') {
          await handleRequirementIntakeCancel(res, req, opts.intakeService, intakeId);
        } else {
          await handleRequirementIntakeArchive(res, opts.intakeService, intakeId);
        }
        return;
      }

      // ── CodeMap endpoints ──────────────────────────────────────────────
      // Serve the dependency graph at three drill-down levels. All read-only
      // GET — the graph is derived from the SQLite codebase index, so these
      // are safe behind the same access-token gate as other /api routes.
      if (url.pathname === '/api/codemap/packages' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (!opts.projectRoot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project root not configured' }));
          return;
        }
        await handleCodemapPackages(res, {
          projectRoot: opts.projectRoot,
          ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
        });
        return;
      }

      if (url.pathname === '/api/codemap/files' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (!opts.projectRoot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project root not configured' }));
          return;
        }
        const pkg = url.searchParams.get('package') ?? '';
        await handleCodemapFiles(
          res,
          {
            projectRoot: opts.projectRoot,
            ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
          },
          pkg,
        );
        return;
      }

      if (url.pathname === '/api/codemap/symbols' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (!opts.projectRoot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project root not configured' }));
          return;
        }
        const file = url.searchParams.get('file') ?? '';
        await handleCodemapSymbols(
          res,
          {
            projectRoot: opts.projectRoot,
            ...(opts.indexDir ? { indexDir: opts.indexDir } : {}),
          },
          file,
        );
        return;
      }

      // ── TechStack endpoints ───────────────────────────────────────────
      if (url.pathname.startsWith('/api/techstack/')) {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (!opts.projectRoot) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project root not configured' }));
          return;
        }
        try {
          const runtime = await getTechStackRuntime();
          const deps = {
            projectId: opts.projectRoot,
            projectRoot: opts.projectRoot,
            store: runtime.store,
            engine: runtime.engine,
            runningJobs: runtime.runningJobs,
            emit: opts.onTechStackEvent,
            getLlm: opts.getLlm,
            executePackageOperation: opts.executePackageOperation,
          };
          if (url.pathname === '/api/techstack/snapshot' && req.method === 'GET') {
            handleTechStackSnapshot(res, deps);
            return;
          }
          if (url.pathname === '/api/techstack/inventory' && req.method === 'POST') {
            handleTechStackInventory(res, deps);
            return;
          }
          if (url.pathname === '/api/techstack/analyze' && req.method === 'POST') {
            handleTechStackAnalyze(res, deps);
            return;
          }
          if (url.pathname === '/api/techstack/trends' && req.method === 'GET') {
            await handleTechStackTrends(res, deps);
            return;
          }
          if (url.pathname === '/api/techstack/remediation' && req.method === 'GET') {
            await handleTechStackRemediationPlan(res, deps);
            return;
          }
          if (url.pathname === '/api/techstack/remediation/apply' && req.method === 'POST') {
            await handleTechStackRemediationApply(req, res, deps);
            return;
          }
          const cancelMatch = /^\/api\/techstack\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
          if (cancelMatch && req.method === 'POST') {
            const id = strictDecodeParam(cancelMatch[1]!, res);
            if (id === null) return;
            handleTechStackCancel(res, deps, id);
            return;
          }
          const jobMatch = /^\/api\/techstack\/jobs\/([^/]+)$/.exec(url.pathname);
          if (jobMatch && req.method === 'GET') {
            const id = strictDecodeParam(jobMatch[1]!, res);
            if (id === null) return;
            handleTechStackJobStatus(res, deps, id);
            return;
          }
          const reportMatch = /^\/api\/techstack\/reports\/([^/]+)$/.exec(url.pathname);
          if (reportMatch && req.method === 'GET') {
            const id = strictDecodeParam(reportMatch[1]!, res);
            if (id === null) return;
            const fmt = url.searchParams.get('format') === 'json' ? 'json' : 'md';
            handleTechStackReport(res, deps, id, fmt);
            return;
          }
          const researchMatch = /^\/api\/techstack\/deps\/([^/]+)\/research$/.exec(url.pathname);
          if (researchMatch && req.method === 'POST') {
            const pkg = strictDecodeParam(researchMatch[1]!, res);
            if (pkg === null) return;
            await handleTechStackDependencyResearch(res, deps, pkg);
            return;
          }
        } catch (error) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: 'TechStack store unavailable',
              detail: sanitizeApiError(error),
            }),
          );
          return;
        }
      }

      // Debug endpoint: /debug/watcher-metrics
      // Returns file watcher metrics as JSON. Protected by the same HTTP access
      // token when the server is bound beyond loopback.
      if (url.pathname === '/debug/watcher-metrics' && req.method === 'GET') {
        if (requireAccessToken && !accessTokenOk) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
        if (opts.watcherMetrics) {
          // Update computed fields before returning
          const avgDelay =
            opts.watcherMetrics.broadcastsSent > 0
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

      // Current WebUI server process memory. This intentionally reports the
      // Node process behind the page (not the browser tab's JavaScript heap),
      // so operators can spot long-running RSS/heap growth from the UI.
      if (url.pathname === '/debug/system' && req.method === 'GET') {
        const processes = await readRecentProcessMemoryDiagnostics(opts.globalRoot);
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(
          JSON.stringify({
            pid: process.pid,
            memoryUsage: process.memoryUsage(),
            heapLimit: v8.getHeapStatistics().heap_size_limit,
            uptime: process.uptime(),
            cpuUsage: process.cpuUsage(),
            codebaseIndexServer: getIndexState().server,
            processes,
            timestamp: Date.now(),
          }),
        );
        return;
      }

      // /api/deadcode/scan
      if (url.pathname === '/api/deadcode/scan' && req.method === 'POST') {
        if (!opts.projectRoot) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Project root not configured' }));
          return;
        }
        await handleDeadCodeScan(
          res,
          {
            projectRoot: opts.projectRoot,
            indexDir: opts.indexDir,
          },
          req,
        );
        return;
      }

      // /api/deadcode/action-plan
      if (url.pathname === '/api/deadcode/action-plan' && req.method === 'POST') {
        await handleDeadCodeActionPlan(
          res,
          {
            projectRoot: opts.projectRoot ?? '',
            indexDir: opts.indexDir,
          },
          req,
        );
        return;
      }

      // An unmatched API path must 404 as an API path. Letting it fall through
      // to the static branch means the SPA fallback answers 200 + index.html
      // for a route that does not exist, which masks typos and route-ordering
      // regressions behind a success status. HQ already does this at
      // hq-server/routes.ts:215 (WS-001).
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }

      let filePath: string;

      if (url.pathname === '/' || url.pathname === '') {
        filePath = path.join(distDir, 'index.html');
      } else {
        filePath = path.join(distDir, url.pathname);
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
      setStaticSecurityHeaders(res);

      if (ext === '.html') {
        if (!shouldSetAuthCookie) res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Content-Security-Policy', buildCspHeader(opts.publicWsUrl, opts.host, port));
        // The frontend derives the WebSocket URL from the page origin since
        // WS now shares the HTTP server port. No WS-port injection needed.
        const html = await fs.readFile(resolvedPath, 'utf8');
        res.writeHead(200);
        res.end(injectWsConfig(html, { publicWsUrl: opts.publicWsUrl }));
        return;
      }

      if (!shouldSetAuthCookie) {
        res.setHeader(
          'Cache-Control',
          url.pathname.startsWith('/assets/')
            ? 'public, max-age=31536000, immutable'
            : 'public, max-age=3600',
        );
      }
      const fileContent = await fs.readFile(resolvedPath);
      res.writeHead(200);
      res.end(fileContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // SPA fallback: serve index.html so client-side routing still works.
        try {
          const html = await fs.readFile(path.join(distDir, 'index.html'), 'utf8');
          setStaticSecurityHeaders(res);
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Security-Policy': buildCspHeader(opts.publicWsUrl, opts.host, port),
          });
          res.end(injectWsConfig(html, { publicWsUrl: opts.publicWsUrl }));
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
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
