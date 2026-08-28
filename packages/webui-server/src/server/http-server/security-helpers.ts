import type * as http from 'node:http';
import * as path from 'node:path';
import {
  extractTokenFromCookie,
  isLoopbackHostname,
} from '../ws-auth.js';

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

export function buildCspHeader(
  publicWsUrl?: string | undefined,
  host?: string,
  port?: number,
): string {
  const connect = new Set(["'self'"]);
  const publicWsSource = publicWsUrl ? cspSourceFromUrl(publicWsUrl) : undefined;
  if (publicWsSource) connect.add(publicWsSource);
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

export function decodeSessionId(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
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
