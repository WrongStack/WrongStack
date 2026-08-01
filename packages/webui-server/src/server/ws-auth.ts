/**
 * WebSocket connection authentication for the WebUI server.
 *
 * Three layered defenses, all enforced in {@link verifyClient}:
 *  1. **DNS-rebinding guard** ({@link hostHeaderOk}) — on a loopback bind the
 *     `Host` header must itself be a loopback name, so a rebound attacker page
 *     (`Host: evil.com`) is rejected even though its TCP peer is 127.0.0.1.
 *  2. **Shared-token auth** ({@link tokenMatches}, constant-time) — required for
 *     any non-loopback origin and for non-browser clients reaching a publicly
 *     bound socket. Tokens are accepted via `Cookie: ws_token=…` (preferred;
 *     set by the `/ws-auth` HTTP endpoint with HttpOnly+SameSite=Strict) OR
 *     `?token=…` URL query param (non-browser fallback).
 *  3. **Loopback bootstrap** — same-machine browser origins are allowed without
 *     a token; the Host-header guard above already blocks cross-site pages.
 *
 * Browser clients (those that send an `Origin` header) authenticate via the
 * HttpOnly cookie by default — the URL `?token=` path is rejected for them,
 * closing the C-598 (Information Exposure Through Query String) class (token in
 * browser history / referrer / proxy logs). The only browser URL-token exception
 * is an explicit public-WS tunnel URL whose origin is allowlisted by the server;
 * that covers separate HTTP/WS hostnames where cookies cannot cross hosts.
 * Non-browser clients (no `Origin`: curl, scripts, tests) keep the URL-token
 * path for ergonomics — query-string exposure is a browser-only concern.
 *
 * Extracted from `index.ts` as pure functions so the auth contract can be unit
 * tested without standing up a real `http.Server`/`WebSocketServer`. `index.ts`
 * builds a thin closure that pulls the fields below off the incoming request.
 */
import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/** A hostname that refers to the local machine. */
export function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/** Effective port of a URL, filling in the protocol default when implicit. */
function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/**
 * Check if an origin is a trusted loopback browser origin *for this server*.
 *
 * WS-003: the WebSocket handshake is exempt from the same-origin policy, so a
 * hostname-only check trusts every other process listening on this machine — a
 * second dev server, a local app's UI, a notebook kernel. Any XSS on any of
 * those origins could then open a tokenless socket here and drive the agent.
 *
 * The `Host` header carries the authority the browser actually connected to, so
 * comparing the Origin's port against it is a genuine same-origin test and needs
 * no extra plumbing. Both sides must still be loopback, and non-http(s) schemes
 * (file://, data://) are rejected outright.
 */
function isTrustedLoopbackOrigin(origin: string, hostHeader: string | undefined): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!isLoopbackHostname(url.hostname)) return false;

    const host = (hostHeader ?? '').trim();
    if (!host) return false;
    const hostUrl = new URL(`${url.protocol}//${host}`);
    if (!isLoopbackHostname(hostUrl.hostname)) return false;

    return effectivePort(url) === effectivePort(hostUrl);
  } catch {
    return false;
  }
}

/** True when the server is bound to a loopback interface (vs. LAN/0.0.0.0). */
export function isLoopbackBind(wsHost: string): boolean {
  return wsHost === '127.0.0.1' || wsHost === '::1' || wsHost === 'localhost';
}

/**
 * True when the server is bound to a wildcard address that exposes it on every
 * interface — IPv4 `0.0.0.0` OR IPv6 `::` (and its bracketed form). The
 * "LAN exposure = deny" guards below must treat both families identically; a
 * `::` bind is exactly as exposed as `0.0.0.0` and previously slipped past the
 * `wsHost === '0.0.0.0'` string check.
 */
export function isWildcardBind(wsHost: string): boolean {
  return wsHost === '0.0.0.0' || wsHost === '::' || wsHost === '[::]';
}

function normalizeHostname(hostname: string): string {
  const h = hostname.trim().toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

function allowedHostname(hostname: string, allowedHostnames?: readonly string[]): boolean {
  const normalized = normalizeHostname(hostname);
  return (allowedHostnames ?? []).some((candidate) => normalizeHostname(candidate) === normalized);
}

/**
 * Constant-time comparison of a provided token against the expected one.
 * A length mismatch short-circuits (lengths aren't secret); equal-length
 * inputs are compared with `timingSafeEqual` so the token can't be recovered
 * byte-by-byte via response timing.
 */
export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the `token` query param out of a request URL (`/?token=…`). */
export function extractToken(url: string): string | undefined {
  const match = url.match(/[?&]token=([^&]+)/);
  return match ? match[1] : undefined;
}

/**
 * Pull the `ws_token` value out of a Cookie header (`Cookie: ws_token=…`).
 * The WebUI's auth-token cookie is set via `Set-Cookie: ws_token=<token>;
 * HttpOnly; SameSite=Strict; Path=/` from the `/ws-auth` HTTP endpoint. The
 * browser then sends it back automatically on the WS upgrade request —
 * closing the C-598 (Information Exposure Through Query String) class
 * because the token never appears in the URL, browser history, or
 * reverse-proxy access logs.
 *
 * Returns `undefined` if the cookie header is absent or malformed.
 */
export function extractTokenFromCookie(cookieHeader: string | string[] | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === 'ws_token') {
      // Cookie values are url-encoded in spec; decode for the constant-time
      // compare downstream. Trim trailing whitespace defensively.
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return part.slice(eq + 1).trim();
      }
    }
  }
  return undefined;
}

/**
 * DNS-rebinding defense. On a loopback bind, the `Host` header must resolve to
 * a loopback name. When the operator deliberately exposes the socket (wsHost is
 * a LAN/0.0.0.0 address) the Host is legitimately non-loopback, so the guard is
 * skipped and connection auth falls to the token check.
 */
export function hostHeaderOk(input: {
  hostHeader: string | undefined;
  wsHost: string;
  allowedHostnames?: readonly string[] | undefined;
}): boolean {
  if (!isLoopbackBind(input.wsHost)) return true; // operator opted into wider exposure
  const hostHeader = (input.hostHeader ?? '').trim();
  if (!hostHeader) return false;
  // Strip the port (handle bare host, host:port, and [::1]:port).
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname) || allowedHostname(hostname, input.allowedHostnames);
}

export interface VerifyClientInput {
  /** Browser `Origin` header, or undefined for non-browser clients. */
  origin?: string | undefined;
  /** Request URL (`req.url`) — carries the `?token=…` query param. */
  url: string;
  /** `Host` header (`req.headers.host`). */
  hostHeader?: string | undefined;
  /** Peer address (`req.socket.remoteAddress`). */
  remoteAddress?: string | undefined;
  /** `Cookie` header (`req.headers.cookie`). Carries `ws_token=…` when the
   *  browser went through `/ws-auth` to set the HttpOnly auth cookie. */
  cookieHeader?: string | string[] | undefined;
  /** Host/interface the WS server is bound to. */
  wsHost: string;
  /** The server's generated auth token. */
  expectedToken: string;
  /** Force token auth even for loopback binds, useful behind public tunnels. */
  requireToken?: boolean | undefined;
  /** Extra Host header names allowed on loopback binds, e.g. a tunnel hostname. */
  allowedHostnames?: readonly string[] | undefined;
  /** Allow browser WS URL tokens for explicit public WS URLs where cookies cannot cross hostnames. */
  allowBrowserUrlToken?: boolean | undefined;
}

/**
 * Decide whether to accept an incoming WebSocket handshake. Pure mirror of the
 * closure previously inlined in `index.ts`; see the module doc for the layered
 * policy. Returns `true` to accept, `false` to reject.
 *
 * Token sources, in priority order:
 *  1. `Cookie: ws_token=…` (browser clients that went through `/ws-auth`)
 *  2. `?token=…` URL query param (non-browser clients: curl, scripts)
 *
 * Browser clients (with an `Origin` header) are restricted to the cookie path —
 * URL token is rejected for them, closing the C-598 query-string token
 * exposure class. Non-browser clients keep the URL-token fallback so curl
 * and tests continue to work.
 */
export function verifyClient(input: VerifyClientInput): boolean {
  const {
    origin,
    url,
    hostHeader,
    remoteAddress,
    cookieHeader,
    wsHost,
    expectedToken,
    requireToken,
    allowedHostnames,
    allowBrowserUrlToken,
  } = input;
  const urlTokenOk = tokenMatches(extractToken(url ?? ''), expectedToken);
  const cookieTokenOk = tokenMatches(extractTokenFromCookie(cookieHeader), expectedToken);

  // DNS-rebinding guard runs first on a loopback bind — independent of token
  // and Origin. Blocks a rebound attacker page (Host = attacker domain) even
  // though the TCP peer is 127.0.0.1.
  if (!hostHeaderOk({ hostHeader, wsHost, allowedHostnames })) return false;

  if (!origin) {
    // Non-browser clients (curl, scripts): require token unless on loopback.
    // The URL `?token=` path stays valid here for ergonomics (curl/tests have
    // no cookie jar) — query-string token exposure (C-598) is a *browser*
    // history/log concern, which non-browser clients don't have.
    // When wsHost=0.0.0.0 the server accepts connections from any network
    // interface. Tokenless connections from non-loopback peers are denied
    // outright, but a valid token (URL or cookie) authenticates non-browser
    // clients from any origin — enabling curl, scripts, and automation tools
    // on Tailscale/LAN peers to reach the WS API with the operator's token.
    const remoteIp = remoteAddress ?? '';
    const isRemoteLoopback = remoteIp === '127.0.0.1' || remoteIp === '::1';
    if (!isRemoteLoopback && isWildcardBind(wsHost) && !urlTokenOk && !cookieTokenOk) return false;
    return urlTokenOk || cookieTokenOk || (isLoopbackBind(wsHost) && !requireToken);
  }
  try {
    const { hostname: originHostname } = new URL(origin);
    // Loopback browser origins: allow without token only if the origin is
    // explicitly http://localhost or http://127.0.0.1 (defense-in-depth).
    // Reject file://, data://, and other schemes even on loopback.
    if (isLoopbackHostname(originHostname)) {
      if (requireToken || !isLoopbackBind(wsHost)) return cookieTokenOk;
      // A valid cookie authenticates regardless of port; otherwise the origin
      // must be this exact server (scheme + loopback host + port), not merely
      // "some loopback origin" (WS-003).
      return cookieTokenOk || isTrustedLoopbackOrigin(origin, hostHeader);
    }
    // Non-loopback browser origins normally authenticate via the HttpOnly cookie
    // set by `/ws-auth`. When an operator supplies a separate public WS URL, the
    // cookie may not cross hostnames, so an explicit opt-in keeps URL-token auth
    // available for that tunnel endpoint.
    return (
      cookieTokenOk ||
      (Boolean(allowBrowserUrlToken) &&
        urlTokenOk &&
        allowedHostname(originHostname, allowedHostnames))
    );
  } catch {
    return false;
  }
}
