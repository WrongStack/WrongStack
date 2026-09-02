import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createHttpServer } from '../src/server/http-server.js';
import { listenWithRetry } from '../src/server/port-utils.js';
import { createWsServers, resolvePorts, type ResolvedPorts } from '../src/server/server-runtime.js';

const HOST = '127.0.0.1';
const TOKEN = 'shared-port-integration-token';

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

function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function occupyEphemeralPort(): Promise<{ port: number; server: net.Server }> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port blocker has no TCP address');
  return { port: address.port, server };
}

async function createDist(title: string): Promise<string> {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webui-shared-port-'));
  await fs.writeFile(path.join(distDir, 'index.html'), `<!doctype html><title>${title}</title>`);
  return distDir;
}

function closeHttpServer(server: import('node:http').Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeWebSocketServer(server: import('ws').WebSocketServer): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
}

describe('standalone WebUI shared port', () => {
  const sockets: WebSocket[] = [];
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(sockets.splice(0).map(closeWebSocket));
    for (const dispose of cleanup.splice(0).reverse()) await dispose();
  });

  async function startSharedServer(options: {
    port: number;
    title: string;
    publicWsUrl?: string | undefined;
  }): Promise<{ port: number; origin: string }> {
    const distDir = await createDist(options.title);
    cleanup.push(() => fs.rm(distDir, { recursive: true, force: true }));

    const httpServer = createHttpServer({
      host: HOST,
      port: options.port,
      distDir,
      apiToken: TOKEN,
      publicWsUrl: options.publicWsUrl,
    });
    const ports: ResolvedPorts = {
      wsHost: HOST,
      httpPort: options.port,
      requireToken: false,
      publicUrl: undefined,
      publicWsUrl: options.publicWsUrl,
    };
    const { wssPrimary } = createWsServers(httpServer, ports, TOKEN);
    // Bind with EADDRINUSE retry: the findFreePort probe above closed its
    // throwaway listener, and on a busy host another process can take the
    // port in that TOCTOU gap. A raw listen() then fails the whole startup
    // with an unhandled error — advance past it instead (shared-port flake,
    // 2026-08-16).
    const boundPort = await listenWithRetry(httpServer, HOST, options.port);
    cleanup.push(() => closeWebSocketServer(wssPrimary));
    cleanup.push(() => closeHttpServer(httpServer));

    return { port: boundPort, origin: `http://${HOST}:${boundPort}` };
  }

  it('serves HTTP and accepts a WebSocket upgrade on the same ephemeral port', async () => {
    const server = await startSharedServer({ port: 0, title: 'shared' });

    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>shared</title>');

    const socket = new WebSocket(`ws://${HOST}:${server.port}/?token=${encodeURIComponent(TOKEN)}`);
    sockets.push(socket);
    await waitForOpen(socket);
    expect(socket.url).toContain(`:${server.port}/`);
  });

  it('rejects the occupied requested port when strict port mode is enabled', async () => {
    const blocker = await occupyEphemeralPort();
    cleanup.push(() => closeServer(blocker.server));

    const previousStrictPort = process.env['WEBUI_STRICT_PORT'];
    process.env['WEBUI_STRICT_PORT'] = '1';
    const ports = await resolvePorts({
      surface: 'webui',
      wsHost: HOST,
      httpPort: blocker.port,
    }).finally(() => {
      if (previousStrictPort === undefined) delete process.env['WEBUI_STRICT_PORT'];
      else process.env['WEBUI_STRICT_PORT'] = previousStrictPort;
    });
    expect(ports.httpPort).toBe(blocker.port);

    const distDir = await createDist('strict');
    cleanup.push(() => fs.rm(distDir, { recursive: true, force: true }));
    const httpServer = createHttpServer({
      host: HOST,
      port: ports.httpPort,
      distDir,
      apiToken: TOKEN,
    });

    await expect(listen(httpServer, ports.httpPort)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });

  it('auto-advances to a free shared port and serves HTTP and WS there', async () => {
    const blocker = await occupyEphemeralPort();
    cleanup.push(() => closeServer(blocker.server));

    // Auto-advance is the default, but only while `WEBUI_STRICT_PORT` is unset —
    // an ambient value in the developer's shell would otherwise flip this test.
    const previousStrictPort = process.env['WEBUI_STRICT_PORT'];
    delete process.env['WEBUI_STRICT_PORT'];
    const ports = await resolvePorts({
      surface: 'webui',
      wsHost: HOST,
      httpPort: blocker.port,
    }).finally(() => {
      if (previousStrictPort !== undefined) process.env['WEBUI_STRICT_PORT'] = previousStrictPort;
    });
    expect(ports.httpPort).toBeGreaterThan(blocker.port);

    const server = await startSharedServer({ port: ports.httpPort, title: 'advanced' });
    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<title>advanced</title>');

    const socket = new WebSocket(`ws://${HOST}:${server.port}/`, {
      headers: { Origin: server.origin },
    });
    sockets.push(socket);
    await waitForOpen(socket);
  });

  it('accepts an exact same-origin browser WebSocket upgrade', async () => {
    const server = await startSharedServer({ port: 0, title: 'same-origin' });
    const socket = new WebSocket(`ws://${HOST}:${server.port}/`, {
      headers: { Origin: server.origin },
    });
    sockets.push(socket);
    await waitForOpen(socket);
  });

  it('injects WEBUI_PUBLIC_WS_URL and accepts its allowlisted proxy origin', async () => {
    const publicWsUrl = 'wss://proxy.example.test/socket';
    const previousPublicWsUrl = process.env['WEBUI_PUBLIC_WS_URL'];
    process.env['WEBUI_PUBLIC_WS_URL'] = publicWsUrl;
    const ports = await resolvePorts({ surface: 'webui', wsHost: HOST, httpPort: 0 }).finally(
      () => {
        if (previousPublicWsUrl === undefined) delete process.env['WEBUI_PUBLIC_WS_URL'];
        else process.env['WEBUI_PUBLIC_WS_URL'] = previousPublicWsUrl;
      },
    );
    expect(ports.publicWsUrl).toBe(publicWsUrl);

    const server = await startSharedServer({
      port: ports.httpPort,
      title: 'proxy',
      publicWsUrl: ports.publicWsUrl,
    });

    const response = await fetch(`${server.origin}/`);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(
      '<meta name="wrongstack-ws-url" content="wss://proxy.example.test/socket" />',
    );
    expect(response.headers.get('content-security-policy')).toContain('wss://proxy.example.test');

    const socket = new WebSocket(
      `ws://${HOST}:${server.port}/?token=${encodeURIComponent(TOKEN)}`,
      { headers: { Origin: 'https://proxy.example.test' } },
    );
    sockets.push(socket);
    await waitForOpen(socket);
  });
});
