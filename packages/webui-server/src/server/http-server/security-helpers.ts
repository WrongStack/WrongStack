import type * as http from 'node:http';
import * as path from 'node:path';
import { decodeSessionIdStrict } from '@wrongstack/core/utils';
import { extractTokenFromCookie, isLoopbackHostname } from '../ws-auth.js';

export const MIME_TYPES: Record<string, string> = {
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

export function setAuthCookieHeaders(
  res: http.ServerResponse,
  token: string,
  secure: boolean,
): void {
  res.setHeader('Set-Cookie', wsTokenCookie(token, secure));
  res.setHeader('Cache-Control', 'no-store');
}

export function setStaticSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

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

export function isLoopbackPeer(req: http.IncomingMessage): boolean {
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

const EXTRA_SCRIPT_SOURCES: readonly string[] = ["'wasm-unsafe-eval'"];

const LOOPBACK_HOST_SPELLINGS: readonly string[] = ['127.0.0.1', 'localhost'];

/**
 * Project an absolute URL onto the `scheme://host[:port]` form CSP accepts as
 * a source expression, or `undefined` when it is not a URL this page may talk
 * to at all.
 *
 * Wider than {@link cspSourceFromUrl}, which only answers for `ws:`/`wss:`:
 * the integration probes in the topbar are plain `fetch()` calls against the
 * operator's HQ and WrongProxy endpoints, so `http:`/`https:` must project too.
 * Anything else (`file:`, `data:`, a bare hostname that does not parse) is
 * dropped rather than echoed into the header.
 */
export function cspConnectOrigin(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl.trim());
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'ws:' &&
      url.protocol !== 'wss:'
    ) {
      return undefined;
    }
    return `${url.protocol}//${formatCspHostname(url.hostname)}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return undefined;
  }
}

/**
 * Every spelling of one loopback origin.
 *
 * `127.0.0.1` and `localhost` are the same server but two distinct CSP
 * sources, and the two halves of the WebUI disagree about which to use: the
 * persisted config may say `http://127.0.0.1:3499` while the browser field
 * (or a default) says `http://localhost:3499`. Allowing only the configured
 * spelling reintroduces the same block for the other one, so a loopback
 * origin contributes both.
 */
function expandLoopbackOrigin(origin: string): string[] {
  const parsed = (() => {
    try {
      return new URL(origin);
    } catch {
      return undefined;
    }
  })();
  if (!parsed) return [origin];
  // `new URL(...).hostname` keeps the brackets on an IPv6 literal, and the CSP
  // host-source grammar has no place for them — a bracketed source is silently
  // dropped by browsers. Unwrap before the loopback test so `http://[::1]:3499`
  // lands on the two spellings that do parse, and drop any other bracketed
  // host rather than emitting a token the browser will ignore.
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1');
  const suffix = parsed.port ? `:${parsed.port}` : '';
  if (!isLoopbackHostname(hostname)) return parsed.hostname.startsWith('[') ? [] : [origin];
  return LOOPBACK_HOST_SPELLINGS.map((h) => `${parsed.protocol}//${h}${suffix}`);
}

export function buildCspHeader(
  publicWsUrl?: string | undefined,
  host?: string,
  port?: number,
  extraConnectSrc?: readonly string[] | undefined,
): string {
  const connect = new Set(["'self'"]);
  const publicWsSource = publicWsUrl ? cspSourceFromUrl(publicWsUrl) : undefined;
  if (publicWsSource) connect.add(publicWsSource);
  for (const raw of extraConnectSrc ?? []) {
    const origin = cspConnectOrigin(raw);
    if (!origin) continue;
    for (const spelling of expandLoopbackOrigin(origin)) connect.add(spelling);
  }
  if (host && isLoopbackHostname(host)) {
    const p = port ?? 3456;
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

export function isInsideDist(candidate: string, distDir: string): boolean {
  const root = path.resolve(distDir);
  const resolved = path.resolve(candidate);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/**
 * Percent-decode a session id from a URL path, or `null` when it is not a
 * usable session id.
 *
 * This used to decode and return, falling back to the RAW segment when
 * `decodeURIComponent` threw — so a malformed or traversal-shaped id reached
 * the handlers. The route patterns are `([^/]+)`, which stops a literal slash
 * but not `%2f`; `..%2f..%2f` decoded straight through. Nothing downstream
 * rejected it either: the only thing standing in the way was
 * `registry.get(sessionId)` happening to miss and returning 404, which is
 * containment by accident rather than by design.
 *
 * HQ's same-named function already validated. Two copies of a path guard, one
 * of which validates, is the drift `@wrongstack/core/utils/path-segment` exists
 * to end — so the rule now has one definition and this delegates to it.
 */
export function decodeSessionId(segment: string): string | null {
  return decodeSessionIdStrict(segment);
}

export function strictDecodeParam(segment: string, res: http.ServerResponse): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid URI encoding in path parameter' }));
    return null;
  }
}
