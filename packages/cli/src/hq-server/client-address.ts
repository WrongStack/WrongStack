/**
 * Client-address resolution for rate limiting behind a reverse proxy.
 *
 * WS-106: HQ's login backoff keys on `req.socket.remoteAddress`. On a direct
 * bind that is exactly right. Behind the documented public-relay / tunnel
 * deployment (`--hq-public-url`, `requireBrowserAuth`) it is exactly wrong:
 * every request arrives from the tunnel's own address, so all users share one
 * bucket and a single attacker's backoff locks out everyone — while a
 * distributed attacker gets no per-source limiting at all.
 *
 * The fix is NOT to read `X-Forwarded-For` whenever it is present. That header
 * is client-supplied; trusting it unconditionally would let an attacker mint a
 * fresh rate-limit identity per request and remove the limiter entirely, which
 * is strictly worse than the shared bucket. It is only meaningful when the
 * operator states how many proxies actually sit in front of HQ.
 *
 * So resolution is opt-in and counted, following the well-understood
 * `trust proxy: <n>` model:
 *
 *   chain = [socket.remoteAddress, ...reverse(X-Forwarded-For)]
 *   client = chain[hops]
 *
 * `hops` is how many trusted proxies stand between the client and this server.
 * The default, 0, ignores the header completely and returns the socket peer —
 * byte-for-byte the previous behaviour.
 *
 * Only the rightmost `hops` entries are ever consulted, because those are the
 * ones trusted infrastructure appended. Everything further left is whatever
 * the client claimed and is never read. If the chain is shorter than `hops`
 * (a client that stripped or under-filled the header), resolution falls back
 * to the socket address rather than reaching into attacker-controlled entries:
 * such requests then share the proxy's bucket, which throttles them rather
 * than freeing them.
 *
 * @module hq-server/client-address
 */

import type * as http from 'node:http';
import { isIP } from 'node:net';

/** Strip an IPv4-mapped IPv6 prefix and any surrounding brackets. */
function normalizeAddress(raw: string): string {
  const trimmed = raw.trim().replace(/^\[(.*)\]$/, '$1');
  return trimmed.replace(/^::ffff:/i, '');
}

/**
 * Parse one `X-Forwarded-For` element into a bare address, or `undefined` when
 * it is not one. Handles `1.2.3.4`, `1.2.3.4:5678`, `[::1]`, and `[::1]:5678`.
 * Anything that does not parse as an IP is dropped — a forwarded chain with a
 * junk entry must not silently become a rate-limit identity of its own.
 */
export function parseForwardedEntry(entry: string): string | undefined {
  const value = entry.trim();
  if (!value) return undefined;

  // Bracketed IPv6, optionally with a port.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(value);
  if (bracketed?.[1] !== undefined) {
    const inner = normalizeAddress(bracketed[1]);
    return isIP(inner) !== 0 ? inner : undefined;
  }

  const normalized = normalizeAddress(value);
  if (isIP(normalized) !== 0) return normalized;

  // Bare `host:port` — only meaningful for IPv4, since a bare IPv6 address
  // contains colons of its own and must be bracketed to carry a port.
  const lastColon = normalized.lastIndexOf(':');
  if (lastColon > 0 && normalized.indexOf(':') === lastColon) {
    const host = normalized.slice(0, lastColon);
    if (isIP(host) === 4) return host;
  }
  return undefined;
}

/** Collect `X-Forwarded-For` values across repeated headers, left to right. */
function forwardedChain(req: http.IncomingMessage): string[] {
  const header = req.headers['x-forwarded-for'];
  if (header === undefined) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw
    .split(',')
    .map((entry) => parseForwardedEntry(entry))
    .filter((entry): entry is string => entry !== undefined);
}

/**
 * Resolve the address a rate limiter should key on.
 *
 * @param req - the incoming request.
 * @param trustedProxyHops - how many trusted reverse proxies sit in front of
 *   this server. `0` (the default) ignores `X-Forwarded-For` entirely.
 * @returns a bare IP address, or `'unknown'` when the socket has none (a
 *   destroyed socket). `'unknown'` is a single shared bucket by design — it
 *   should throttle, not exempt.
 */
export function resolveClientAddress(
  req: http.IncomingMessage,
  trustedProxyHops = 0,
): string {
  const socketAddress = req.socket.remoteAddress
    ? normalizeAddress(req.socket.remoteAddress)
    : undefined;

  const hops = Number.isFinite(trustedProxyHops) ? Math.max(0, Math.trunc(trustedProxyHops)) : 0;
  if (hops === 0) return socketAddress ?? 'unknown';

  // chain[0] is the peer we actually accepted the connection from; each further
  // element is one hop further out, i.e. the header read right to left.
  const chain = [...(socketAddress !== undefined ? [socketAddress] : []), ...forwardedChain(req).reverse()];
  // Under-filled chain — do not reach past what trusted proxies wrote.
  if (hops >= chain.length) return socketAddress ?? 'unknown';
  return chain[hops] ?? socketAddress ?? 'unknown';
}
