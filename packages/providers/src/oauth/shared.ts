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
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Random CSRF state (hex). */
export function createState(): string {
  return randomBytes(16).toString('hex');
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
    return {
      code: url.searchParams.get('code') ?? undefined,
      state: url.searchParams.get('state') ?? undefined,
    };
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

export function callbackHtml(ok: boolean, message: string): string {
  const heading = ok ? 'Authentication successful' : 'Authentication failed';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"/>` +
    `<title>${heading}</title><style>body{margin:0;min-height:100vh;display:flex;` +
    `align-items:center;justify-content:center;background:#09090b;color:#fafafa;` +
    `font-family:ui-sans-serif,system-ui,sans-serif;text-align:center}` +
    `h1{font-size:26px;margin:0 0 8px}p{color:#a1a1aa}</style></head><body><main>` +
    `<h1>${heading}</h1><p>${message}</p></main></body></html>`
  );
}

export interface LoopbackServer {
  /** Resolves with `{ code, state }`, or null if cancelled / failed to bind. */
  waitForCode(): Promise<{ code: string; state: string } | null>;
  close(): void;
  /** True when the server bound to the port; false means the port was busy. */
  readonly bound: boolean;
}

export interface LoopbackOptions {
  port: number;
  host: string;
  /** Expected callback path, e.g. `/auth/callback` or `/callback`. */
  path: string;
  /** Expected OAuth `state` — a mismatch aborts the wait (CSRF guard). */
  expectedState: string;
  /** Abort (e.g. user cancel) → unblock the pending wait and tear down. */
  signal?: AbortSignal | undefined;
}

/**
 * Start a one-shot loopback HTTP server that captures the OAuth redirect.
 * Resolves once listening (or once it fails to bind — in which case `bound`
 * is false and the caller falls back to manual paste).
 */
export function startLoopbackServer(opts: LoopbackOptions): Promise<LoopbackServer> {
  const { port, host, path, expectedState, signal } = opts;
  let resolveCode: (v: { code: string; state: string } | null) => void = () => {};
  const codePromise = new Promise<{ code: string; state: string } | null>((resolve) => {
    let settled = false;
    resolveCode = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
  });

  const server: Server = createServer((req, res) => {
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
      res.end(callbackHtml(false, 'Callback route not found.'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const err = url.searchParams.get('error');
    if (err) {
      res.statusCode = 400;
      res.end(callbackHtml(false, `Authorization error: ${err}`));
      resolveCode(null);
      return;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'State mismatch — please restart the login.'));
      resolveCode(null);
      return;
    }
    if (!code) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'Missing authorization code.'));
      return;
    }
    res.statusCode = 200;
    res.end(callbackHtml(true, 'You can close this window and return to WrongStack.'));
    resolveCode({ code, state });
  });

  const onAbort = (): void => {
    resolveCode(null);
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  return new Promise<LoopbackServer>((resolve) => {
    server.on('error', () => {
      // Port busy / cannot bind — signal manual fallback.
      resolveCode(null);
      resolve({
        bound: false,
        waitForCode: () => Promise.resolve(null),
        close: () => {
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
    server.listen(port, host, () => {
      resolve({
        bound: true,
        waitForCode: () => codePromise,
        close: () => {
          resolveCode(null);
          try {
            server.close();
          } catch {
            /* ignore */
          }
        },
      });
    });
  });
}
