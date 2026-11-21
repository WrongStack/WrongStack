import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MCPOAuthCallbackServerOptions {
  /** Fixed port when the authorization server requires a preregistered URI. */
  port?: number | undefined;
  path?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface MCPOAuthCallbackServer {
  /** Exact redirect URI to pass to the authorization request. */
  redirectUri: string;
  /** Resolves with the full callback URL the browser was redirected to. */
  waitForCallback(): Promise<string>;
  close(): void;
}

const DEFAULT_PATH = '/callback';
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** A browser may probe /favicon.ico and the user may reload; the cap stops a loop. */
const MAX_REQUESTS = 16;

/**
 * Loopback redirect receiver for the manual OAuth flow.
 *
 * Without this the user had to copy the callback URL out of the browser address
 * bar and paste it back into a second command. The listener binds 127.0.0.1
 * only — never a routable interface — and answers exactly one path, so nothing
 * else on the machine can reach it or enumerate its responses.
 */
export async function startMcpOAuthCallbackServer(
  options: MCPOAuthCallbackServerOptions = {},
): Promise<MCPOAuthCallbackServer> {
  const path = normalizePath(options.path ?? DEFAULT_PATH);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('MCP OAuth callback timeout must be a positive finite number');
  }
  options.signal?.throwIfAborted();

  let settle: ((value: string) => void) | undefined;
  let fail: ((error: Error) => void) | undefined;
  let finished = false;
  let requests = 0;
  const callback = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Nothing awaits this promise until waitForCallback() is called, and the
  // listener can reject before then (abort, timeout). Without this the rejection
  // would surface as an unhandled rejection and take the process down.
  callback.catch(() => undefined);

  const server = http.createServer((req, res) => {
    if (finished || ++requests > MAX_REQUESTS) {
      res.writeHead(429).end();
      return;
    }
    // The Host header is attacker-influenced; the request line is what routes.
    let requestUrl: URL;
    try {
      requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Bad request');
      return;
    }
    if (req.method !== 'GET' || requestUrl.pathname !== path) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    finished = true;
    res
      .writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        // The URL carries a one-shot authorization code; keep it out of caches
        // and out of the next site the user visits.
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
      })
      .end(SUCCESS_PAGE);
    const address = server.address() as AddressInfo | null;
    const port = address?.port ?? 0;
    settle?.(`http://127.0.0.1:${port}${req.url ?? path}`);
  });

  server.on('error', (error) => {
    finished = true;
    fail?.(error);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Loopback only. Binding 0.0.0.0 would expose the code receiver to the LAN.
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  if (options.signal?.aborted) {
    server.closeAllConnections?.();
    server.close(() => undefined);
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : new Error('MCP OAuth callback wait was aborted');
  }

  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error('MCP OAuth callback listener failed to bind a loopback port');
  }
  const redirectUri = `http://127.0.0.1:${address.port}${path}`;

  const MAX_TIMEOUT_MS = 2_147_483_647;
  let remainingMs = timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const scheduleTimeout = () => {
    const chunk = Math.min(remainingMs, MAX_TIMEOUT_MS);
    remainingMs -= chunk;
    timer = setTimeout(() => {
      if (remainingMs > 0) {
        scheduleTimeout();
        return;
      }
      finished = true;
      fail?.(new Error(`MCP OAuth callback was not received within ${timeoutMs}ms`));
      close();
    }, chunk);
    timer.unref?.();
  };
  scheduleTimeout();

  const onAbort = () => {
    finished = true;
    fail?.(
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('MCP OAuth callback wait was aborted'),
    );
    close();
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });

  function close(): void {
    if (!finished) {
      finished = true;
      fail?.(new Error('MCP OAuth callback listener was closed'));
    }
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    // closeAllConnections exists on Node 18.2+; a keep-alive browser connection
    // otherwise keeps the listener (and the process) alive after success.
    server.closeAllConnections?.();
    server.close(() => undefined);
  }

  return {
    redirectUri,
    waitForCallback: () => callback.finally(close),
    close,
  };
}

function normalizePath(value: string): string {
  if (!value.startsWith('/') || value.length > 256 || /[?#\s]/.test(value)) {
    throw new Error('MCP OAuth callback path must be a bounded absolute path without query');
  }
  return value;
}

const SUCCESS_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorized</title></head>
<body style="font-family:system-ui,sans-serif;padding:3rem;text-align:center">
<h1>Authorization complete</h1>
<p>You can close this tab and return to WrongStack.</p>
</body></html>
`;
