import * as http from 'node:http';
import * as net from 'node:net';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from '../src/ws-runtime.js';
import { runWebUI } from '../src/webui-server.js';

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket did not open')), 5_000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timer);
      reject(new Error(`WebSocket upgrade rejected with ${response.statusCode}`));
    });
  });
}

function closeWebSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 1_000);
    socket.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.close();
  });
}

async function reserveEphemeralPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port probe has no TCP address');
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

let serverDone: Promise<void> | null = null;
let clientSocket: WebSocket | null = null;
let integrationServer: http.Server | null = null;

await afterEach(async () => {
  if (clientSocket) {
    await closeWebSocket(clientSocket);
    clientSocket = null;
  }
  if (serverDone) {
    process.emit('SIGTERM');
    await serverDone;
    serverDone = null;
  }
  if (integrationServer) {
    await new Promise<void>((resolve) => integrationServer!.close(() => resolve()));
    integrationServer = null;
  }
});

describe('runWebUI frontend serving', () => {
  it('serves the React frontend over HTTP with the live WS port injected', async () => {
    const events = new EventBus();
    // `url` is the tokenized access URL `runWebUI` announces (see
    // `WebUIServerOptions.onListening`). Needed since H3 — the HTTP surface
    // requires a token on every bind, so the test fetches the announced URL
    // rather than a bare origin.
    let info:
      | { httpPort: number; wsPort: number; host: string; url: string; authToken: string }
      | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });

    const port = await reserveEphemeralPort();
    const probePaths: string[] = [];
    integrationServer = http.createServer((req, res) => {
      probePaths.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => integrationServer!.listen(0, '127.0.0.1', resolve));
    const integrationAddress = integrationServer.address() as net.AddressInfo;
    const integrationUrl = `http://127.0.0.1:${integrationAddress.port}`;
    const meta: Record<string, unknown> = {};
    serverDone = runWebUI({
      port,
      httpPort: port,
      profileConfigPath: '/tmp/test-profile.json',
      onListening: (i) => {
        info = i;
        signalReady?.();
      },
      events,
      appConfig: {
        hq: { enabled: true, url: integrationUrl },
        tools: { wrongProxy: { enabled: true, url: integrationUrl } },
      } as never,
      session: { id: 'test-session' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' }, meta },
        run: vi.fn(),
      } as never,
    });

    await listening;
    expect(info).toBeDefined();
    expect(info!.wsPort).toBe(info!.httpPort);

    // The HTTP server should serve index.html with this instance's WS port
    // stamped in — that's what lets the browser connect back to THIS backend.
    // onListening fires on the WS server; the HTTP server listens separately and
    // can lag well past a tick under full-suite + coverage-instrumentation load,
    // so poll with vi.waitFor (retries on ECONNREFUSED) rather than a fixed
    // attempt budget that flakes when the machine is saturated.
    // Use the announced access URL, not a bare origin: since H3 the HTTP
    // surface requires a token on every bind, and `accessUrl` is exactly the
    // tokenized first-load URL the CLI prints and a browser opens. Fetching a
    // bare `/` here would assert the pre-H3 behavior.
    const url = info!.url;
    let res: Response | undefined;
    await vi.waitFor(
      async () => {
        res = await fetch(url);
      },
      { timeout: 8000, interval: 50 },
    );
    if (!res) throw new Error(`HTTP server never became reachable at ${url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html');
    const html = await res.text();
    expect(html.toLowerCase()).toContain('<!doctype html>');

    const origin = `http://${info!.host}:${info!.httpPort}`;
    for (const kind of ['hq', 'wrong-proxy']) {
      const status = await fetch(`${origin}/api/integrations/${kind}/status`, {
        headers: { 'X-WS-Token': info!.authToken },
      });
      expect(status.status).toBe(200);
      await expect(status.json()).resolves.toMatchObject({ connected: true });
    }
    expect(probePaths).toEqual(['/api/auth/status', '/api/health']);
    meta['hqEnabled'] = false;
    const disabled = await fetch(`${origin}/api/integrations/hq/status`, {
      headers: { 'X-WS-Token': info!.authToken },
    });
    expect(disabled.status).toBe(503);
    clientSocket = new WebSocket(
      `ws://${info!.host}:${info!.httpPort}/?token=${encodeURIComponent(info!.authToken)}`,
      { headers: { Origin: origin } },
    );
    await waitForOpen(clientSocket);
    expect(clientSocket.url).toContain(`:${info!.httpPort}/`);
  });
});
