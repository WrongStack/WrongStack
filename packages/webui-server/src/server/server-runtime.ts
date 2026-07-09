/**
 * Server lifecycle helpers for the standalone WebUI server.
 *
 * Phase 1e of the god-module split: the port resolution, WS auth/server
 * creation, event arming, session-start payload builder, HTTP server
 * startup, and graceful shutdown registration all moved here from
 * `start-webui.ts` so the orchestrator reads as connect-the-dots.
 *
 * Each function is a pure construction step — no behaviour change. The
 * WS/HTTP/shutdown wiring that used to be inline (~370 lines) now lives
 * behind four focused entry points.
 */
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { Config, ModelsRegistry } from '@wrongstack/core';
import { WebSocketServer, type WebSocket } from 'ws';
import { verifyClient as verifyWsClient } from './ws-auth.js';
import { buildWebUIAccessUrl, envFlag, errMessage, resolveAuthToken } from './ws-utils.js';
import { findFreePort } from './port-utils.js';
import { openBrowser } from './open-browser.js';
import { createHttpServer } from './http-server.js';
import { registerInstance } from './instance-registry.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { setupEvents, type FileWatcherMetrics } from './setup-events.js';
import { getCostRates } from './usage-cost.js';
import { resolveProviderModelMetadata } from './model-catalog.js';
import type { ConnectedClient } from './types.js';
import { toErrorMessage } from '@wrongstack/core/utils';

// ── Port resolution ─────────────────────────────────────────────────────

export interface ResolvedPorts {
  wsHost: string;
  wsPort: number;
  httpPort: number;
  publicUrl: string | undefined;
  publicWsUrl: string | undefined;
  requireToken: boolean;
}

/**
 * Resolve bind host, HTTP/WS ports, public URLs, and the token-required flag
 * from CLI opts + env vars. Auto-advances past taken ports unless
 * `WEBUI_STRICT_PORT` is set.
 */
export async function resolvePorts(opts: {
  wsPort?: number | undefined;
  wsHost?: string | undefined;
  httpPort?: number | undefined;
  webuiPort?: number | undefined;
  port?: number | undefined;
  publicUrl?: string | undefined;
  publicWsUrl?: string | undefined;
  requireToken?: boolean | undefined;
}): Promise<ResolvedPorts> {
  const requestedWsPort = opts.wsPort ?? 3457;
  const wsHost = opts.wsHost ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const requestedHttpPort =
    opts.httpPort ?? opts.webuiPort ?? opts.port ??
    Number.parseInt(process.env['WEBUI_PORT'] ?? process.env['PORT'] ?? '3456', 10);
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');

  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let wsPort = requestedWsPort;
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    httpPort = await findFreePort(wsHost, requestedHttpPort);
    wsPort = await findFreePort(wsHost, requestedWsPort, { exclude: new Set([httpPort]) });
    if (httpPort !== requestedHttpPort) {
      console.warn(JSON.stringify({ level: 'warn', event: 'webui.port_reassigned', protocol: 'HTTP', requested: requestedHttpPort, assigned: httpPort, timestamp: new Date().toISOString() }));
    }
    if (wsPort !== requestedWsPort) {
      console.warn(JSON.stringify({ level: 'warn', event: 'webui.port_reassigned', protocol: 'WS', requested: requestedWsPort, assigned: wsPort, timestamp: new Date().toISOString() }));
    }
  }
  return { wsHost, wsPort, httpPort, publicUrl, publicWsUrl, requireToken };
}

// ── Session start payload ───────────────────────────────────────────────

export interface SessionStartPayloadGetters {
  getConfig(): Config;
  getSessionId(): string;
  getProjectRoot(): string;
  getWorkingDir(): string;
  getModeId(): string;
  getContextMode(): string;
  getNeedsSetup(): boolean;
  modelsRegistry: ModelsRegistry;
}

/**
 * Build a factory that produces the rich session.start payload from current
 * runtime state. Reads live values through getters so post-/new, post-resume,
 * and post-model.switch all broadcast the same shape.
 */
export function createSessionStartPayload(g: SessionStartPayloadGetters): () => Promise<{
  sessionId: string;
  model: string;
  provider: string;
  maxContext: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  projectName: string;
  projectRoot: string;
  cwd: string;
  mode: string;
  contextMode: string;
  needsSetup?: boolean | undefined;
}> {
  return async () => {
    const config = g.getConfig();
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    try {
      const m = await resolveProviderModelMetadata(
        g.modelsRegistry,
        config.provider,
        config.model,
        config.providers?.[config.provider],
      );
      maxContext = m?.capabilities?.maxContext ?? 0;
      if (!maxContext) {
        try {
          const provider = await (g.modelsRegistry as {
            getProvider(id: string): Promise<{ models: Array<{ id: string; limit?: { context?: number } }> } | undefined>;
          }).getProvider(config.provider);
          const rawModel = provider?.models.find((mod) => mod.id === config.model);
          maxContext = rawModel?.limit?.context ?? 0;
        } catch {
          /* best-effort */
        }
      }
      const rates = getCostRates(m);
      inputCost = rates.input;
      outputCost = rates.output;
      cacheReadCost = rates.cacheRead;
    } catch {
      // best-effort
    }
    const projectRoot = g.getProjectRoot();
    const result: {
      sessionId: string; model: string; provider: string; maxContext: number;
      inputCost: number; outputCost: number; cacheReadCost: number;
      projectName: string; projectRoot: string; cwd: string; mode: string; contextMode: string;
      needsSetup?: boolean | undefined;
    } = {
      sessionId: g.getSessionId(),
      model: config.model,
      provider: config.provider,
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      projectName: path.basename(projectRoot) || projectRoot,
      projectRoot,
      cwd: g.getWorkingDir(),
      mode: g.getModeId(),
      contextMode: g.getContextMode(),
    };
    if (g.getNeedsSetup()) result.needsSetup = true;
    return result;
  };
}

// ── WebSocket servers ───────────────────────────────────────────────────

export interface WsServerResult {
  wssPrimary: WebSocketServer;
  wssSecondary: WebSocketServer | null;
  wsToken: string;
  clients: Map<WebSocket, ConnectedClient>;
}

/**
 * Create the primary (+ optional IPv6 secondary) WebSocket servers with
 * CSWSH token auth. Returns the servers + the shared clients map.
 */
export function createWsServers(
  ports: ResolvedPorts,
  accessToken: string | undefined,
): WsServerResult {
  const wsToken = resolveAuthToken(accessToken);
  console.log('[WebUI] WS auth token ready');
  const publicHostnames = [ports.publicUrl, ports.publicWsUrl]
    .map((value) => {
      if (!value) return undefined;
      try { return new URL(value).hostname; } catch { return undefined; }
    })
    .filter((value): value is string => Boolean(value));

  const verifyClient = (info: {
    origin: string; secure: boolean; req: import('node:http').IncomingMessage;
  }) =>
    verifyWsClient({
      origin: info.origin,
      url: info.req.url ?? '',
      hostHeader: info.req.headers.host,
      remoteAddress: info.req.socket.remoteAddress,
      cookieHeader: info.req.headers.cookie,
      wsHost: ports.wsHost,
      expectedToken: wsToken,
      requireToken: ports.requireToken,
      allowedHostnames: publicHostnames,
      allowBrowserUrlToken: Boolean(ports.publicWsUrl),
    });

  const WS_MAX_PAYLOAD = 8 * 1024 * 1024;
  const wssPrimary = new WebSocketServer({
    port: ports.wsPort, host: ports.wsHost, verifyClient, maxPayload: WS_MAX_PAYLOAD,
  } as ConstructorParameters<typeof WebSocketServer>[0]);
  const wssSecondary = ports.wsHost === '127.0.0.1'
    ? new WebSocketServer({
        port: ports.wsPort, host: '::1', verifyClient, maxPayload: WS_MAX_PAYLOAD,
      } as ConstructorParameters<typeof WebSocketServer>[0])
    : null;
  const clients = new Map<WebSocket, ConnectedClient>();
  console.log(
    `[WebUI] WebSocket server running on ws://${ports.wsHost}:${ports.wsPort}` +
      (wssSecondary ? ` (and ws://[::1]:${ports.wsPort})` : ''),
  );
  return { wssPrimary, wssSecondary, wsToken, clients };
}

// ── Event arming + WS error handlers ────────────────────────────────────

export interface EventArmingResult {
  disposeEvents: () => void;
  fleetBroadcast: () => Promise<void>;
}

/**
 * Wire setupEvents (the once-only event→WS-broadcast bridge) behind a
 * listening-callback guard, and attach WS server error handlers. Returns
 * the dispose + fleet-broadcast functions.
 */
export function armEvents(
  wssPrimary: WebSocketServer,
  wssSecondary: WebSocketServer | null,
  wsHost: string,
  wsPort: number,
  setupInput: Parameters<typeof setupEvents>[0],
  watcherMetrics: FileWatcherMetrics,
): { arm: (label: string) => void; getDispose: () => (() => void) | null; getFleetBroadcast: () => (() => Promise<void>) | null } {
  let eventsArmed = false;
  let disposeEvents: (() => void) | null = null;
  let fleetBroadcast: (() => Promise<void>) | null = null;

  const arm = (label: string): void => {
    if (eventsArmed) return;
    eventsArmed = true;
    console.log(`[WebUI] Backend ready (${label})`);
    disposeEvents = setupEvents({ ...setupInput, watcherMetrics, onFleetBroadcaster: (fn) => { fleetBroadcast = fn; } });
  };

  wssPrimary.on('listening', () => arm(`${wsHost}:${wsPort}`));
  wssPrimary.on('error', (err) => {
    console.error(JSON.stringify({ level: 'error', event: 'webui.ws_server_error', host: wsHost, message: toErrorMessage(err), timestamp: new Date().toISOString() }));
  });
  if (wssSecondary) {
    wssSecondary.on('listening', () => arm(`::1:${wsPort}`));
    wssSecondary.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        console.warn(JSON.stringify({ level: 'warn', event: 'webui.ipv6_unavailable', code: err.code, message: err.message, timestamp: new Date().toISOString() }));
      } else {
        console.error(JSON.stringify({ level: 'error', event: 'webui.ws_server_error', host: '::1', message: err.message, timestamp: new Date().toISOString() }));
      }
    });
  }
  return {
    arm,
    getDispose: () => disposeEvents,
    getFleetBroadcast: () => fleetBroadcast,
  };
}

// ── HTTP server + shutdown ──────────────────────────────────────────────

/**
 * Resolve the directory containing the built WebUI frontend assets.
 *
 * The standalone webui-server package does not bundle the React frontend;
 * it lives in the separate `@wrongstack/webui` package. Callers can pass an
 * explicit `distDir`; when they don't, we try to resolve the frontend package
 * relative to the server entry that is asking. This lets the standalone
 * `wstackui` binary serve the webui assets when both packages are installed,
 * while also allowing embedded callers (e.g. the desktop app) to pass an exact
 * path so they don't depend on module-resolution layout.
 */
export function resolveWebuiDistDir(fromUrl: string, explicitDistDir?: string | undefined): string {
  if (explicitDistDir) return path.resolve(explicitDistDir);
  try {
    const requireFromHere = createRequire(fromUrl);
    const serverEntry = requireFromHere.resolve('@wrongstack/webui/server');
    return path.resolve(path.dirname(serverEntry), '..'); // .../dist
  } catch {
    // Legacy fallback: assume the webui dist is co-located with the server
    // runtime (the pre-extraction layout). This path is wrong for the
    // extracted @wrongstack/webui-server package, but keeping it preserves
    // any bespoke/test setups that still lay out files that way.
    return path.resolve(path.dirname(fileURLToPath(fromUrl)), '..', '..', 'dist');
  }
}

export function startHttpServer(opts: {
  wsHost: string;
  httpPort: number;
  wsPort: number;
  wsToken: string;
  publicWsUrl: string | undefined;
  publicUrl: string | undefined;
  requireToken: boolean;
  globalRoot: string;
  globalConfigPath: string;
  projectRoot: string;
  openBrowser: boolean;
  watcherMetrics: FileWatcherMetrics;
  onFleetPing: () => void;
  distDir?: string | undefined;
}): import('node:http').Server {
  const httpServer = createHttpServer({
    host: opts.wsHost,
    distDir: resolveWebuiDistDir(import.meta.url, opts.distDir),
    wsPort: opts.wsPort,
    publicWsUrl: opts.publicWsUrl,
    globalRoot: opts.globalRoot,
    apiToken: opts.wsToken,
    requireToken: opts.requireToken,
    watcherMetrics: opts.watcherMetrics,
    onFleetPing: opts.onFleetPing,
  });
  const registryBaseDir = path.dirname(opts.globalConfigPath);
  httpServer.listen(opts.httpPort, opts.wsHost, () => {
    const openUrl = buildWebUIAccessUrl({ host: opts.wsHost, port: opts.httpPort, token: opts.wsToken, publicUrl: opts.publicUrl });
    console.log(`[WebUI] HTTP server running on ${openUrl}`);
    if (opts.openBrowser) openBrowser(openUrl);
    void registerInstance(
      { pid: process.pid, httpPort: opts.httpPort, wsPort: opts.wsPort, host: opts.wsHost, projectRoot: opts.projectRoot, projectName: path.basename(opts.projectRoot) || opts.projectRoot, startedAt: new Date().toISOString(), url: buildWebUIAccessUrl({ host: opts.wsHost, port: opts.httpPort, publicUrl: opts.publicUrl }) },
      registryBaseDir,
    ).catch((err) => console.warn(JSON.stringify({ level: 'warn', event: 'webui.instance_record_failed', message: errMessage(err), timestamp: new Date().toISOString() })));
  });
  return httpServer;
}

export interface ShutdownDeps {
  flushSession: () => Promise<void>;
  clients: () => IterableIterator<WebSocket>;
  servers: Array<import('node:http').Server | WebSocketServer>;
  onShutdown: () => Promise<void> | void;
}

export function registerShutdown(deps: ShutdownDeps): void {
  registerShutdownHandlers({
    flushSession: deps.flushSession,
    clients: deps.clients,
    servers: deps.servers,
    onShutdown: deps.onShutdown,
  });
}
