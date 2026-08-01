/**
 * Shared loopback OAuth server — HTTP callback listener for OAuth flows.
 *
 * Both the Codex ("Sign in with ChatGPT") and Anthropic ("Sign in with Claude")
 * OAuth flows start a local HTTP server on a loopback port to receive the
 * authorization code redirect from the provider's browser flow. Before this
 * module existed, each flow duplicated:
 *
 *   - `escapeHtml` / `callbackHtml` — render success/error HTML pages
 *   - `openBrowser` — best-effort platform browser opener
 *   - `startLoopbackServer` — HTTP server with port fallback, abort handling,
 *     state validation, and callback URL parsing
 *
 * Usage:
 * ```ts
 * import { startLoopbackServer, callbackHtml, openBrowser } from './loopback-server.js';
 *
 * const server = await startLoopbackServer(state, [1455, 1457], signal);
 * const code = await server.waitForCode();
 * ```
 *
 * @module auth-menu/loopback-server
 */

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';

// ── HTML rendering ────────────────────────────────────────────────────────

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

/**
 * Render a simple dark-themed HTML response for the browser callback page.
 * Shared by all loopback-based OAuth flows so the success/error page styling
 * is consistent and the HTML generation isn't duplicated.
 */
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

// ── Platform browser opener (best-effort) ─────────────────────────────────

/**
 * Open a URL in the user's default browser. Best-effort — never throws.
 *
 * - Windows: `cmd /c start "" <url>`
 * - macOS: `open <url>`
 * - Linux: `xdg-open <url>`
 */
export function openBrowser(url: string): void {
  try {
    const platform = process.platform;
    const { command, args } =
      platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : platform === 'darwin'
          ? { command: 'open', args: [url] }
          : { command: 'xdg-open', args: [url] };
    const child = spawn(command, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort — the URL is always printed in the terminal.
  }
}

// ── Loopback callback server ──────────────────────────────────────────────

/** Result of waiting for the OAuth callback. */
export interface LoopbackCallback {
  /** The authorization code from the provider. */
  code: string;
  /** The OAuth state parameter from the callback (validated against expected). */
  state: string;
}

export interface LoopbackServer {
  /**
   * Wait for the browser to redirect back with the authorization code.
   * Resolves with the code and state, or `null` if cancelled/failed.
   */
  waitForCode(): Promise<LoopbackCallback | null>;
  /** Close the HTTP server and release the port. */
  close(): void;
  /** True when the server bound to a registered callback port. */
  readonly bound: boolean;
  /** The actual port the server is listening on (matches the authorize URL redirect_uri). */
  readonly port: number;
}

/**
 * Start a loopback HTTP server for OAuth authorization code callback.
 *
 * The server listens on the first available port from `ports`. If all ports
 * are busy, `bound` is `false` and the caller should fall back to a manual
 * paste prompt.
 *
 * When `signal` aborts (user pressed Ctrl+C or TUI Esc), the pending
 * `waitForCode()` promise resolves to `null` and the server is torn down
 * so the login flow can return promptly.
 *
 * @param expectedState - The OAuth `state` value to validate against the callback
 * @param ports - Ordered list of TCP ports to try (first available wins)
 * @param signal - Optional external cancellation signal
 * @param callbackPath - The URL path the provider redirects to (default `/auth/callback`)
 * @param redirectHost - The hostname to listen on (default `127.0.0.1`)
 */
export function startLoopbackServer(
  expectedState: string,
  ports: readonly number[],
  signal?: AbortSignal,
  callbackPath = '/auth/callback',
  redirectHost = '127.0.0.1',
): Promise<LoopbackServer> {
  let resolveCode: (v: LoopbackCallback | null) => void = () => {};
  const codePromise = new Promise<LoopbackCallback | null>((resolve) => {
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
      url = new URL(req.url ?? '', `http://${redirectHost}`);
    } catch {
      res.statusCode = 400;
      res.end();
      return;
    }
    if (url.pathname !== callbackPath) {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      // Static page: deny scripts and framing so this loopback origin cannot be
      // used as an XSS/clickjacking foothold (CLICK-001).
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('referrer-policy', 'no-referrer');
      res.end(callbackHtml(false, 'Callback route not found.'));
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const err = url.searchParams.get('error');
    if (err) {
      res.statusCode = 400;
      res.end(callbackHtml(false, `Authorization error: ${err}`));
      resolveCode(null);
      return;
    }
    const state = url.searchParams.get('state') ?? '';
    if (state !== expectedState) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'State mismatch — please restart the login.'));
      resolveCode(null);
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      res.statusCode = 400;
      res.end(callbackHtml(false, 'Missing authorization code.'));
      return;
    }
    res.statusCode = 200;
    res.end(callbackHtml(true, 'You can close this window and return to the terminal.'));
    resolveCode({ code, state });
  });

  // Abort (Ctrl+C / TUI Esc) → unblock the pending wait and close the server.
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
    const close = (): void => {
      resolveCode(null);
      try {
        server.close();
      } catch {
        /* ignore */
      }
    };

    const fail = (): void => {
      resolveCode(null);
      resolve({
        bound: false,
        port: ports[0] ?? 1455,
        waitForCode: () => Promise.resolve(null),
        close,
      });
    };

    let index = 0;
    server.on('error', () => {
      index += 1;
      const nextPort = ports[index];
      if (nextPort !== undefined) {
        server.listen(nextPort, redirectHost);
        return;
      }
      fail();
    });

    server.on('listening', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : ports[index] ?? 1455;
      resolve({
        bound: true,
        port,
        waitForCode: () => codePromise,
        close,
      });
    });

    server.listen(ports[0] ?? 1455, redirectHost);
  });
}
