/**
 * Shared, IO-free primitives for the headless OAuth login engine.
 *
 * These were previously duplicated inside the CLI's `auth-menu/*-oauth.ts`
 * terminal flows. They live here so BOTH the CLI and the two WebUI servers
 * can drive a subscription sign-in without depending on terminal IO or a
 * particular config-persistence layer.
 *
 * Nothing here opens a browser or writes config — the caller (CLI renderer
 * or WebSocket handler) decides how to surface the authorize URL and how to
 * persist the resulting {@link import('./index.js').OAuthLoginOutcome}.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

// ── PKCE ────────────────────────────────────────────────────────────────────

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE verifier + S256 challenge. */
export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Random CSRF state, URL-safe like the upstream Codex OAuth flow. */
export function createState(): string {
  return base64url(randomBytes(32));
}

// ── Manual-paste parsing ──────────────────────────────────────────────────────

/**
 * Parse a pasted authorization code or full redirect URL into `{ code, state }`.
 * Handles three shapes: a full `http://localhost:PORT/...?code=&state=` URL, a
 * bare `code#state` (Anthropic's hash convention), a `code=...&state=...` query
 * fragment, or a bare code.
 */
export function parseAuthorizationInput(input: string): {
  code?: string | undefined;
  state?: string | undefined;
} {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    const code = url.searchParams.get('code') ?? undefined;
    const state = url.searchParams.get('state') ?? undefined;
    if (code) {
      return { code, state };
    }
    if (url.hash) {
      const hashContent = url.hash.slice(1);
      if (hashContent.includes('code=')) {
        const params = new URLSearchParams(hashContent);
        return {
          code: params.get('code') ?? undefined,
          state: params.get('state') ?? state,
        };
      }
      if (hashContent.includes('#')) {
        const [hCode, hState] = hashContent.split('#', 2);
        return { code: hCode, state: hState || state };
      }
      if (hashContent) {
        return { code: hashContent, state };
      }
    }
    return { code, state };
  } catch {
    /* not a URL */
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2);
    return { code, state };
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value);
    return {
      code: params.get('code') ?? undefined,
      state: params.get('state') ?? undefined,
    };
  }
  return { code: value };
}

// ── Loopback callback server ──────────────────────────────────────────────────

const ESCAPE_HTML: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPE_HTML[ch] ?? ch);
}

export function callbackHtml(ok: boolean, message: string): string {
  const heading = ok ? 'Authentication successful' : 'Authentication failed';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>` +
    `<title>${escapeHtml(heading)}</title><style>body{margin:0;min-height:100vh;display:flex;` +
    `align-items:center;justify-content:center;background:#09090b;color:#fafafa;` +
    `font-family:ui-sans-serif,system-ui,sans-serif;text-align:center}` +
    `h1{font-size:26px;margin:0 0 8px}p{color:#a1a1aa}</style></head><body><main>` +
    `<h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></main></body></html>`
  );
}

export interface LoopbackServer {
  /** Resolves with `{ code, state }`, or null if cancelled / failed to bind. */
  waitForCode(): Promise<{ code: string; state: string; clientId?: string } | null>;
  close(): void;
  /** True when the server bound to a callback port; false means all ports were busy. */
  readonly bound: boolean;
  /** Actual callback port selected by the listener. */
  readonly port: number;
}

export interface LoopbackOptions {
  port: number;
  fallbackPorts?: number[] | undefined;
  host: string;
  /** Expected callback path, e.g. `/auth/callback` or `/callback`. */
  path: string;
  /** Expected OAuth `state` — a mismatch aborts the wait (CSRF guard). */
  /** Expected OAuth state. Omit only for providers whose protocol does not return state. */
  expectedState?: string | undefined;
  /** Abort (e.g. user cancel) → unblock the pending wait and tear down. */
  signal?: AbortSignal | undefined;
}

/**
 * Start a one-shot loopback HTTP server that captures the OAuth redirect.
 * Resolves once listening (or once it fails to bind — in which case `bound`
 * is false and the caller falls back to manual paste).
 */
const EPHEMERAL_LISTEN_RETRIES = 3;
const EPHEMERAL_LISTEN_BACKOFF_MS = 25;

export function startLoopbackServer(opts: LoopbackOptions): Promise<LoopbackServer> {
  const { port, fallbackPorts = [], host, path, expectedState, signal } = opts;
  let resolveCode: (v: { code: string; state: string; clientId?: string } | null) => void =
    () => {};
  let detachAbort = (): void => {};
  const codePromise = new Promise<{ code: string; state: string; clientId?: string } | null>(
    (resolve) => {
      let settled = false;
      resolveCode = (v) => {
        if (settled) return;
        settled = true;
        detachAbort();
        resolve(v);
      };
    },
  );

  const server: Server = createServer((req, res) => {
    // One-shot server: every response is the last one this socket will carry.
    // Without this the browser (and undici, in tests) holds the connection
    // keep-alive for `server.keepAliveTimeout` (5s by default), and Node's
    // `server.close()` refuses to release the listening socket while any
    // connection is still open. The callback port is FIXED for several
    // providers — Anthropic can only ever use 53692 — so a port held for
    // seconds after a completed login makes the very next attempt fall back to
    // the manual-paste prompt for no reason.
    res.setHeader('connection', 'close');
    let url: URL;
    try {
      url = new URL(req.url ?? '', `http://${host}`);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (url.pathname !== path) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.end(callbackHtml(false, 'Callback route not found.'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    // The callback page is static; deny scripts and framing outright so this
    // loopback origin cannot be used as an XSS/clickjacking foothold (WS-002).
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const err = url.searchParams.get('error');
    if (err) {
      res.statusCode = 400;
      res.end(callbackHtml(false, `Authorization error: ${err}`));
      server.close(() => resolveCode(null));
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (expectedState !== undefined && state !== expectedState) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'State mismatch — please restart the login.'));
      server.close(() => resolveCode(null));
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'Missing authorization code.'));
      return;
    }
    res.statusCode = 200;
    res.end(callbackHtml(true, 'You can close this window and return to WrongStack.'));
    const clientId = url.searchParams.get('client_id');
    server.close(() =>
      resolveCode({ code, state: state ?? '', ...(clientId ? { clientId } : {}) }),
    );
  });

  /**
   * Release the listening socket *now*. `server.close()` alone only stops
   * accepting — it keeps the port bound until every established connection
   * ends, so a browser tab left open on the callback page (or an abort that
   * arrives mid-request) pins a fixed callback port indefinitely.
   */
  const teardown = (): void => {
    try {
      // Stop accepting first, then drop whatever is still attached — Node's
      // documented shutdown order. Forcing the second step is safe here: the
      // only thing this server ever writes is the static confirmation page,
      // already flushed (the handler sends `Connection: close`), and teardown
      // only runs once the flow is finished or cancelled.
      server.close();
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
  };

  const onAbort = (): void => {
    resolveCode(null);
    teardown();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => signal.removeEventListener('abort', onAbort);
    }
  }

  return new Promise<LoopbackServer>((resolve) => {
    const ports = [port, ...fallbackPorts];
    let index = 0;

    const close = (): void => {
      resolveCode(null);
      teardown();
    };

    const fail = (): void => {
      resolveCode(null);
      resolve({
        bound: false,
        port,
        waitForCode: () => Promise.resolve(null),
        close,
      });
    };

    let ephemeralRetries = 0;
    server.on('error', () => {
      // Port 0 asks the OS for any free port, so a failure there is transient
      // (seen on a loaded Windows host) rather than "this port is taken":
      // ask again a few times before falling back to manual entry.
      if ((ports[index] ?? port) === 0 && ephemeralRetries < EPHEMERAL_LISTEN_RETRIES) {
        ephemeralRetries += 1;
        setTimeout(() => server.listen(0, host), EPHEMERAL_LISTEN_BACKOFF_MS * ephemeralRetries);
        return;
      }
      index += 1;
      const nextPort = ports[index];
      if (nextPort !== undefined) {
        server.listen(nextPort, host);
        return;
      }
      // All requested callback ports are busy / unavailable — signal manual fallback.
      fail();
    });
    server.on('listening', () => {
      const address = server.address();
      const actualPort =
        typeof address === 'object' && address ? address.port : (ports[index] ?? port);
      resolve({
        bound: true,
        port: actualPort,
        waitForCode: () => codePromise,
        close,
      });
    });
    server.listen(ports[index] ?? port, host);
  });
}
