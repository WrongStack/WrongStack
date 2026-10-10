/**
 * HTTP + WebSocket listeners for the CLI-embedded WebUI host: the static
 * frontend (when built), the authenticated WS bridge, the deferred SimpleUI
 * bind, the IPv6 loopback proxy and the ready banner.
 */

import type { Server as HttpServer, IncomingMessage } from 'node:http';
import {
  createDefaultFileWatcherMetrics,
  findInstalledPackageJson,
  type SessionAgentRegistry,
} from '@wrongstack/webui-server';
import { verifyClient as verifyWsClient } from '@wrongstack/webui-server/server/ws-auth';
import type { CliWebUIOptions } from '../webui-server-options.js';
import { WebSocketServer } from '../ws-runtime.js';
import { announceWebuiReady } from './lifecycle.js';
import { startDeferredHttpListen, startIpv6LoopbackProxy } from './listen-helpers.js';
import { consoleLogger } from './logger-shim.js';
import { startStaticServe } from './static-serve.js';
import type { WebuiTransport } from './transport.js';

export interface WebuiHttpBridgeInput {
  opts: CliWebUIOptions;
  surface: 'webui' | 'simpleui';
  host: string;
  httpPort: number;
  strictPort: boolean;
  globalRoot: string;
  wsToken: string;
  publicUrl: string | undefined;
  publicWsUrl: string | undefined;
  requireToken: boolean;
  getSessionAgents: () => SessionAgentRegistry | undefined;
  onFleetPing: () => void;
  broadcast: WebuiTransport['broadcast'];
  /** The bind advanced past the requested port; called before anything else reads the port. */
  onPortRebound: (port: number) => void;
}

export async function startWebuiHttpBridge(input: WebuiHttpBridgeInput) {
  const {
    opts,
    surface,
    host,
    strictPort,
    globalRoot,
    wsToken,
    publicUrl,
    publicWsUrl,
    requireToken,
    getSessionAgents,
    onFleetPing,
    broadcast,
    onPortRebound,
  } = input;
  let httpPort = input.httpPort;
  const httpServer = await startStaticServe({
    getSessionProjectRoot: (sessionId) =>
      getSessionAgents()?.peek(sessionId)?.ctx.projectRoot ??
      (opts.agent.ctx.session?.id === sessionId ? opts.agent.ctx.projectRoot : undefined),
    host,
    httpPort,
    globalRoot,
    distDir: opts.frontendDistDir,
    ensureDistDeps: {
      resolvePackageJson: (id) => {
        const packageJson = findInstalledPackageJson(id, import.meta.url);
        if (!packageJson) throw new Error(`Package not found: ${id}`);
        return packageJson;
      },
    },
    onFleetPing,
    // Without this, /debug/watcher-metrics 503s and the Debug Dashboard has to
    // report the watcher as "Unavailable". The CLI host runs no status watcher
    // of its own, so this object stays all-zero and watcherActive reads false —
    // which is the truthful state for an embedded host.
    watcherMetrics: createDefaultFileWatcherMetrics(),
    onTechStackEvent: (event) => broadcast(event),
    getLlm: () =>
      opts.agent.ctx.provider && opts.agent.ctx.model
        ? { provider: opts.agent.ctx.provider, model: opts.agent.ctx.model }
        : undefined,
    projectRoot: opts.projectRoot,
    publicWsUrl,
    apiToken: wsToken,
    requireToken,
    deferListen: surface === 'simpleui',
    strictPort,
    // Resolve the same-origin health probes from live preferences, including
    // changes made after boot, just like the standalone WebUI host.
    getIntegrationTarget: (kind) => {
      const meta = opts.agent.ctx.meta;
      const enabledKey = kind === 'hq' ? 'hqEnabled' : 'wrongProxyEnabled';
      const urlKey = kind === 'hq' ? 'hqUrl' : 'wrongProxyUrl';
      return meta[enabledKey] === true && typeof meta[urlKey] === 'string'
        ? (meta[urlKey] as string)
        : undefined;
    },
    ...(opts.getVectorMemoryStore ? { getVectorMemoryStore: opts.getVectorMemoryStore } : {}),
    ...(opts.vectorMemoryModelCacheDir
      ? { vectorMemoryModelCacheDir: opts.vectorMemoryModelCacheDir }
      : {}),
  });

  // E5 (DOS-004): the previous CLI path constructed the
  // `WebSocketServer` with no `verifyClient` callback, so a hostile
  // page (or any random non-browser client) could complete the WS
  // handshake and only then be rejected at the application-layer
  // `authenticate` step. Every accepted handshake allocates a `ws`
  // instance, two buffers, and a per-connection upgrade — the
  // `for(;;) new WebSocket(...)` loop in a hostile tab is cheap
  // memory/FD pressure on the agent host. The standalone server
  // already wires `verifyClient`; mirror that on the CLI host.
  // `WS-003` is left to its standalone setting (the Vite dev loop).
  const verifyClient = (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
    verifyWsClient({
      origin: info.origin,
      url: info.req.url ?? '',
      hostHeader: info.req.headers.host,
      remoteAddress: info.req.socket.remoteAddress,
      cookieHeader: info.req.headers.cookie,
      wsHost: host,
      expectedToken: wsToken,
      requireToken,
      allowedHostnames: [publicUrl, publicWsUrl].filter((value): value is string => Boolean(value)),
      allowBrowserUrlToken: Boolean(publicWsUrl),
      allowCrossPortLoopbackCookie: process.env['WRONGSTACK_WEBUI_DEV_CROSS_PORT_WS'] === '1',
    });

  const wss = httpServer
    ? new WebSocketServer({ server: httpServer.server, verifyClient, maxPayload: 20 * 1024 * 1024 })
    : new WebSocketServer({ port: httpPort, host, verifyClient, maxPayload: 20 * 1024 * 1024 });

  // Armed at construction, not at wiring time. Constructing a WebSocketServer
  // with {server} makes `ws` forward that HTTP server's 'error' events onto
  // this emitter, and the SimpleUI surface binds the HTTP server AFTER this
  // point (deferListen). A bind error arriving while this emitter had no
  // 'error' listener threw out of the emit loop as an uncaughtException,
  // which skipped the remaining HTTP-server 'error' listeners — including
  // listenWithRetry's — so the awaited bind never settled and startup hung
  // forever. Bun on Windows reaches that window routinely (phantom
  // EADDRINUSE on a free port), Node can reach it through a genuine
  // probe-to-bind race.
  wss.on('error', (err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'webui_server.error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });

  if (httpServer) {
    const boundPort =
      surface === 'simpleui'
        ? await startDeferredHttpListen({
            server: httpServer.server,
            host,
            httpPort,
            logger: consoleLogger,
            strictPort,
          })
        : httpServer.port;
    if (boundPort !== httpPort) {
      // The bind advanced past a TOCTOU competitor — every downstream
      // consumer (access URL, WS bridge, instance registry, ready banner)
      // must carry the actually-bound port.
      httpPort = boundPort;
      onPortRebound(boundPort);
    }
  }

  let ipv6LoopbackServer: HttpServer | null = null;
  if (httpServer && host === '127.0.0.1') {
    ipv6LoopbackServer = await startIpv6LoopbackProxy({
      primary: httpServer.server,
      httpPort,
      logger: consoleLogger,
    });
  }

  console.log(`[WebUI] WebSocket server starting on ws://${host}:${httpPort}`);

  if (httpServer) {
    announceWebuiReady({
      surface,
      server: httpServer.server,
      host,
      httpPort,
      open: !!opts.open,
      wsToken,
      publicUrl,
    });
  } else {
    console.warn(
      `[WebUI] Frontend not served (run \`pnpm --filter @wrongstack/webui build\`). ` +
        `WS bridge still active on ws://${host}:${httpPort}.`,
    );
  }

  return { httpServer, wss, ipv6LoopbackServer };
}
