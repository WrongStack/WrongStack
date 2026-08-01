/**
 * HQ server — authentication, cookie management, and security headers.
 *
 * @module hq-server/auth
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type * as http from 'node:http';
import { isIP } from 'node:net';
import { hqTokenVerifier, isLoopbackHost, isTokenExpired } from '@wrongstack/core/hq';
import type { HqSessionEntry } from './types.js';

// ── Cookie / session constants ─────────────────────────────────────────────

export const HQ_SESSION_COOKIE = 'hq.session';
export const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types ──────────────────────────────────────────────────────────────────

export interface HqBrowserAuthContext {
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
export interface HqCookieAuthContext {
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
    // File:// origins (the HQ dashboard served from a local file for
    // air-gapped use) are also trusted. The request Host was checked above.
    if (parsed.protocol === 'file:') return true;
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

export function setHqSessionCookie(
  res: http.ServerResponse,
  value: string,
  secure?: boolean,
): void {
  const parts = [
    `${HQ_SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(HQ_SESSION_MAX_AGE_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function clearHqSessionCookie(res: http.ServerResponse, secure?: boolean): void {
  const parts = [`${HQ_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`];
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
    const cookies = parseCookieHeader(req.headers.cookie);
    const raw = cookies[HQ_SESSION_COOKIE];
    if (raw) {
      const sessionId = parseHqSessionCookie(raw, mutableAuth.cookieSecret);
      // Server-side session expiry: reject and evict entries past Max-Age
      // even if the periodic cleanup timer hasn't run yet.
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session && Date.now() - session.createdAt < HQ_SESSION_MAX_AGE_MS) {
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
