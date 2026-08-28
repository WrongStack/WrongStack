/**
 * HQ server — authentication, cookie management, and security headers.
 *
 * @module hq-server/auth
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import { isIP } from 'node:net';
import { hqTokenVerifier, isLoopbackHost, isTokenExpired } from '@wrongstack/core/hq';
import type { HqRouterMutableAuth, HqSessionEntry } from './types.js';

// ── Cookie / session constants ─────────────────────────────────────────────

export const HQ_SESSION_COOKIE = 'hq.session';

/**
 * When the server is running with `Secure` cookies (HTTPS / public tunnel),
 * use the `__Host-` prefix for defense-in-depth. Browsers enforce:
 * - Must be sent only over HTTPS (Secure)
 * - Must have Path=/
 * - Must NOT have a Domain attribute
 * This prevents cookie injection from subdomains on shared origins.
 *
 * On loopback (HTTP, no Secure), the prefix can't be used — browsers reject
 * `__Host-` cookies without `Secure`. The plain `hq.session` name is fine
 * there since subdomain injection isn't a concern on localhost.
 */
const HQ_SESSION_COOKIE_SECURE = '__Host-hq.session';

function cookieName(secure: boolean | undefined): string {
  return secure ? HQ_SESSION_COOKIE_SECURE : HQ_SESSION_COOKIE;
}
export const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Idle timeout: sessions unused for this long are rejected and evicted. */
export const HQ_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000; // 30 min

// ── Types ──────────────────────────────────────────────────────────────────

interface HqBrowserAuthContext {
  kind: 'token';
  token: string;
  id: string;
  capabilities?: string[];
}

/**
 * Cookie-session auth context — returned when a valid `hq.session` cookie
 * is presented. Password-origin cookies have `kind: 'cookie'` (full
 * access). Token-origin cookies carry the source token's capabilities
 * so capability checks (e.g. `control.enqueue`) still apply.
 */
interface HqCookieAuthContext {
  kind: 'cookie';
  tokenId?: string;
  capabilities?: string[];
}

export type HqBrowserAuthResult = HqBrowserAuthContext | HqCookieAuthContext | undefined;

// ── Security headers ───────────────────────────────────────────────────────

/**
 * The only featureful frontend is the packaged, same-origin React SPA.
 * The missing-assets recovery document contains inline CSS but no script.
 *
 * WS-061: `script-src` carried `'unsafe-inline'` despite that sentence above
 * already stating nothing here needs it — verified against the built HTML,
 * which has zero inline `<script>` elements without `src`. `style-src` keeps
 * `'unsafe-inline'` because the recovery document's inline CSS is real, and
 * inline style is not script execution.
 */
export function setHqSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "img-src 'self' data:",
      "connect-src 'self'",
    ].join('; '),
  );
}

// ── CORS / origin guard ────────────────────────────────────────────────────

function hasTrustedRequestAuthority(
  req: http.IncomingMessage,
  boundHost: string | undefined,
  boundPort: number | undefined,
  trustedPublicOrigins: ReadonlySet<string>,
): boolean {
  const rawHost = req.headers.host?.trim();
  if (!rawHost) return false;

  try {
    const requestUrl = new URL(`http://${rawHost}`);
    // Reject anything other than a bare authority (for example, userinfo, a
    // path, query, or fragment). Do not compare normalized `.host` with the
    // raw value: URL parsing intentionally removes explicit default ports.
    if (
      requestUrl.username ||
      requestUrl.password ||
      requestUrl.pathname !== '/' ||
      requestUrl.search ||
      requestUrl.hash
    ) {
      return false;
    }

    for (const origin of trustedPublicOrigins) {
      const trusted = new URL(origin);
      const normalizedRequest = new URL(`${trusted.protocol}//${rawHost}`);
      if (trusted.host.toLowerCase() === normalizedRequest.host.toLowerCase()) return true;
    }

    const hostname = requestUrl.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
    const requestPort = requestUrl.port || '80';
    // Port 0 asks the OS to assign an ephemeral port; the handler receives the
    // actual port only in Host, so treat 0 like an unspecified expected port.
    const portMatches =
      boundPort === undefined || boundPort === 0 || requestPort === String(boundPort);
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (isLoopback) return portMatches;

    // Literal LAN addresses are safe from hostname rebinding. They are trusted
    // only for a wildcard bind (or when they equal an explicit IP bind).
    if (isIP(hostname) !== 0) {
      const normalizedBoundHost = boundHost?.toLowerCase().replace(/^\[(.*)\]$/, '$1');
      const permitsIpHost =
        normalizedBoundHost === undefined ||
        normalizedBoundHost === '0.0.0.0' ||
        normalizedBoundHost === '::' ||
        normalizedBoundHost === hostname;
      return permitsIpHost && portMatches;
    }

    // An explicitly configured named bind is an operator-owned trust decision.
    // Arbitrary request-selected hostnames are never authorized.
    return boundHost?.toLowerCase() === hostname && portMatches;
  } catch {
    return false;
  }
}

export function hasTrustedBrowserOrigin(
  req: http.IncomingMessage,
  boundHost?: string,
  boundPort?: number,
  trustedPublicOrigins: ReadonlySet<string> = new Set(),
  allowFileOrigin = false,
): boolean {
  // Host authorization is required even when browsers omit Origin (notably on
  // same-origin GET/HEAD). Otherwise DNS rebinding can still read open-mode HQ
  // telemetry through an attacker-selected authority.
  if (!hasTrustedRequestAuthority(req, boundHost, boundPort, trustedPublicOrigins)) return false;

  const origin = req.headers.origin;
  // Non-browser clients commonly omit Origin, but their Host authority still
  // has to identify the configured HQ endpoint.
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    // `file:` origins support serving the HQ dashboard from a local file for
    // air-gapped use, but they are OFF unless explicitly enabled (WS-081).
    //
    // The Host check above does not contain them: any local HTML file can aim
    // its requests at the real HQ authority, and Chromium sends a literal
    // `Origin: file://` on WebSocket handshakes too. So an unconditional trust
    // here meant any page the user opened from disk cleared the ONLY
    // cross-origin control on both the HTTP and WS surfaces — and in open mode
    // /ws/browser needs no token, making that a full telemetry and transcript
    // read. The session cookie is not reachable this way (SameSite=Lax blocks
    // it on a cross-site WS), so token and password modes were unaffected;
    // open mode was not.
    if (parsed.protocol === 'file:') return allowFileOrigin;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    const rawRequestHost = req.headers.host?.trim();
    if (!rawRequestHost) return false;
    const requestHost = new URL(`${parsed.protocol}//${rawRequestHost}`).host.toLowerCase();
    if (parsed.host.toLowerCase() !== requestHost) return false;

    // Public hostnames must match the exact registered scheme as well as the
    // authority. Local/LAN requests are served over HTTP directly.
    const registeredPublicOrigin = [...trustedPublicOrigins].some(
      (trustedOrigin) => new URL(trustedOrigin).host.toLowerCase() === requestHost,
    );
    return !registeredPublicOrigin || trustedPublicOrigins.has(parsed.origin.toLowerCase());
  } catch {
    // Unparseable origin → reject.
    return false;
  }
}

// ── Session cookie helpers ──────────────────────────────────────────────────

function signHqSession(sessionId: string, secret: string): string {
  return createHmac('sha256', secret).update(sessionId).digest('hex');
}

export function serializeHqSessionCookie(sessionId: string, secret: string): string {
  return `${sessionId}.${signHqSession(sessionId, secret)}`;
}

export function parseHqSessionCookie(value: string, secret: string): string | undefined {
  const dot = value.indexOf('.');
  if (dot === -1) return undefined;
  const sessionId = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  if (!sessionId || !sig) return undefined;
  const expected = signHqSession(sessionId, secret);
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  } catch {
    return undefined;
  }
  return sessionId;
}

export function parseCookieHeader(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof cookieHeader !== 'string') return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(value);
      } catch {
        // Malformed percent-encoding (e.g. %ZZ, %FF without valid UTF-8)
        // throws URIError. Return the raw value rather than crashing.
        out[key] = value;
      }
    }
  }
  return out;
}

/**
 * Read the HQ session cookie, preferring the `__Host-`-prefixed name.
 *
 * WS-103: every reader open-coded `cookies[HQ_SESSION_COOKIE] ??
 * cookies['__Host-hq.session']`, which prefers the UNPREFIXED name. The whole
 * point of the `__Host-` prefix is that a browser refuses to accept such a
 * cookie unless it is Secure, Path=/, and Domain-less — guarantees a plain
 * `hq.session` set by a sibling subdomain does not carry. Reading the weak name
 * first hands that injected value precedence over the hardened one on exactly
 * the deployments (`secure`) where the prefix was doing work.
 *
 * Signature verification still stands behind this, so a forged cookie needs
 * `cookieSecret` — but preference order is the layer whose only job is to stop
 * the attacker-controlled name from winning, so it should not be inverted.
 */
export function readHqSessionCookie(cookieHeader: string | undefined): string | undefined {
  const cookies = parseCookieHeader(cookieHeader);
  return cookies[HQ_SESSION_COOKIE_SECURE] ?? cookies[HQ_SESSION_COOKIE];
}

export function setHqSessionCookie(
  res: http.ServerResponse,
  value: string,
  secure?: boolean,
): void {
  const name = cookieName(secure);
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(HQ_SESSION_MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearHqSessionCookie(res: http.ServerResponse, secure?: boolean): void {
  const name = cookieName(secure);
  const parts = [`${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ── Auth result helpers ─────────────────────────────────────────────────────

export function isTokenAuth(auth: HqBrowserAuthResult): auth is HqBrowserAuthContext {
  return auth !== undefined && auth.kind === 'token';
}

export function isCookieAuth(auth: HqBrowserAuthResult): auth is HqCookieAuthContext {
  return auth !== undefined && auth.kind === 'cookie';
}

// ── Auth requirement predicate ──────────────────────────────────────────────

/**
 * Single source of truth for "must this HQ surface see a credential?".
 *
 * WS-010 introduced `requireAuthFloor` so that revoking the last credential on
 * a running, network-reachable `wstack hq` could not silently drop it into open
 * mode. That latch was then honoured at only three of the seven decision
 * points. The four that open-coded their own `browserTokens.size > 0 ||
 * passwordHash` test stayed open: the main `/api/*` gate, the mailbox gateway,
 * the WebSocket upgrade, and `callerCanEnqueue` — which backs `/api/mailbox-send`,
 * i.e. message injection into live agents.
 *
 * Any new gate MUST call this rather than re-deriving the condition; the bug
 * was not a wrong condition but seven independent copies of it (WS-077).
 */
export function hqAuthRequired(
  mutableAuth: HqRouterMutableAuth,
  requireBrowserAuth?: boolean | undefined,
): boolean {
  return (
    requireBrowserAuth === true ||
    mutableAuth.requireAuthFloor === true ||
    mutableAuth.browserTokens.size > 0 ||
    mutableAuth.passwordHash !== undefined
  );
}

/**
 * The `/ws/client` counterpart. Fleet clients authenticate with `clientTokens`,
 * which are a separate set from the browser tokens, but the same fail-closed
 * floor applies: an all-expired client-token file must not mean "no auth
 * configured, let anyone register as a session".
 */
export function hqClientAuthRequired(mutableAuth: HqRouterMutableAuth): boolean {
  return mutableAuth.requireAuthFloor === true || mutableAuth.clientTokens.size > 0;
}

// ── Request auth ───────────────────────────────────────────────────────────

function extractBrowserToken(req: http.IncomingMessage, url: URL): string | undefined {
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    // Tokens in URL query strings can leak through browser history, server
    // access logs, and Referer headers. The built React dashboard uses the
    // Authorization header; the inline fallback and manual curl access use the
    // query param, so it stays available where the leak channels are local.
    //
    // WS-009: this file already told operators to "use the Authorization header
    // instead" once HQ is exposed beyond localhost, but nothing enforced it, and
    // `assessHqExposure` only warns that "tokens ... appear in the URL query".
    // Off-loopback the leak is real — proxy logs, shared history, Referer to
    // third-party origins — so refuse there rather than repeating the advice.
    // The Host header is safe to trust here: hasTrustedRequestAuthority has
    // already pinned it to the configured bind before any handler runs.
    const requestHost = (req.headers.host ?? '').trim();
    let hostname = '';
    try {
      hostname = new URL(`http://${requestHost}`).hostname;
    } catch {
      /* unparseable Host → treat as non-loopback */
    }
    if (hostname && isLoopbackHost(hostname)) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'hq.token_from_query_param',
          message:
            'Browser token accepted from URL query parameter — token can leak through browser history, server access logs, and Referer headers.',
          timestamp: new Date().toISOString(),
        }),
      );
      return queryToken;
    }
    // Rejected off-loopback — but fall through rather than returning, so a
    // client that also sent a valid Authorization header still authenticates.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'hq.token_from_query_param_rejected',
        message:
          'Browser token in URL query rejected on a non-loopback request — send it in the Authorization header instead.',
        timestamp: new Date().toISOString(),
      }),
    );
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  return undefined;
}

/**
 * Constant-time membership test for a token set. Returns the matching stored
 * token (so callers can look up its metadata) or undefined. Iterates and
 * compares each candidate with `timingSafeEqual` instead of `Set.has()`, whose
 * hash lookup can leak token length/prefix via timing. Use this everywhere an
 * HQ token is checked — the HTTP path and the WS-upgrade path alike.
 */
export function timingSafeTokenMatch(tokens: Set<string>, supplied: string): string | undefined {
  if (!supplied) return undefined;
  // WS-044: `tokens` holds verifiers (`sha256(secret)`), not secrets, so the
  // presented secret is hashed before it is compared. Every entry is then the
  // same 64 bytes, which as a side effect removes the length signal the
  // constant-time loop below could not hide.
  const b = Buffer.from(hqTokenVerifier(supplied));
  for (const candidate of tokens) {
    const a = Buffer.from(candidate);
    if (a.length === b.length && timingSafeEqual(a, b)) return candidate;
  }
  return undefined;
}

export function authenticateBrowserRequest(
  req: http.IncomingMessage,
  url: URL,
  mutableAuth: {
    browserTokens: Set<string>;
    browserTokenObjs: Map<string, { id: string; capabilities?: string[]; expiresAt?: string }>;
    passwordHash?: string | undefined;
    cookieSecret?: string | undefined;
  },
  sessions: Map<string, HqSessionEntry>,
): HqBrowserAuthResult {
  const token = extractBrowserToken(req, url);
  if (token) {
    const matchedToken = timingSafeTokenMatch(mutableAuth.browserTokens, token);
    if (matchedToken) {
      const obj = mutableAuth.browserTokenObjs.get(matchedToken);
      // WS-011: expiry was only applied when the auth watcher rebuilt the live
      // set, so between passes — and after any reload — an expired token still
      // authenticated. `tokenHasCapability` checks expiry, but a token with no
      // `capabilities` never reaches it. Check it here, at the boundary.
      if (isTokenExpired(obj)) return undefined;
      const ctx: HqBrowserAuthContext = {
        kind: 'token',
        token: matchedToken,
        id: obj?.id ?? 'unknown',
      };
      if (obj?.capabilities !== undefined) ctx.capabilities = obj.capabilities;
      return ctx;
    }
  }
  if (mutableAuth.cookieSecret) {
    // Check both cookie names: __Host-hq.session (secure) and hq.session
    // (loopback). The browser only sends the one that was set; when both are
    // present the hardened name wins — see `readHqSessionCookie`.
    const raw = readHqSessionCookie(req.headers.cookie);
    if (raw) {
      const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret);
      // Server-side session expiry: reject and evict entries past Max-Age
      // even if the periodic cleanup timer hasn't run yet.
      if (sessionId) {
        const session = sessions.get(sessionId);
        const now = Date.now();
        if (session && now - session.createdAt < HQ_SESSION_MAX_AGE_MS) {
          // Pending 2FA: the password was correct but the TOTP/recovery code
          // has not been verified yet. Treat as NOT authenticated on all
          // routes except /api/login/verify (which is exempted from the gate).
          if (session.pending2fa) return undefined;
          // Idle timeout: reject sessions idle for longer than the configured
          // window. Evict so the stale cookie doesn't linger.
          if (now - session.lastSeenAt > HQ_SESSION_IDLE_TIMEOUT_MS) {
            sessions.delete(sessionId);
            return undefined;
          }
          // Sliding refresh: bump lastSeenAt on every authenticated request so
          // active sessions stay alive while idle ones expire.
          session.lastSeenAt = now;
          // For token-origin sessions, resolve capabilities from the LIVE
          // token record (not the cached session entry) so that a capability
          // change in auth.json takes effect immediately rather than at
          // session expiry.
          if (session.kind === 'token' && session.tokenId !== undefined) {
            const liveToken = [...mutableAuth.browserTokenObjs.values()].find(
              (obj) => obj.id === session.tokenId,
            );
            if (!liveToken) {
              sessions.delete(sessionId);
              return undefined;
            }
            const ctx: HqCookieAuthContext = { kind: 'cookie', tokenId: session.tokenId };
            if (liveToken.capabilities !== undefined) ctx.capabilities = liveToken.capabilities;
            return ctx;
          }
          // Password-origin sessions have full access.
          return { kind: 'cookie' as const };
        }
        // Stale session — evict so a replayed cookie doesn't linger.
        if (session) sessions.delete(sessionId);
      }
    }
  }
  return undefined;
}
