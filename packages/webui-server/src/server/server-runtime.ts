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

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config, ModelsRegistry } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils';
import { protocolAdvertisement } from '@wrongstack/webui-protocol';
import { type WebSocket, WebSocketServer } from 'ws';
import { createHttpServer } from './http-server.js';
import { createProjectIntakeService } from './intake-service.js';
import { registerShutdownHandlers } from './lifecycle.js';
import { resolveProviderModelMetadata } from './model-catalog.js';
import { findFreePort, isStrictPort } from './port-utils.js';
import { type FileWatcherMetrics, setupEvents } from './setup-events.js';
import type { ConnectedClient } from './types.js';
import { getCostRates } from './usage-cost.js';
import { verifyClient as verifyWsClient } from './ws-auth.js';
import { envFlag, resolveAuthToken } from './ws-utils.js';

// ── Port resolution ─────────────────────────────────────────────────────

export interface ResolvedPorts {
  wsHost: string;
  httpPort: number;
  publicUrl: string | undefined;
  publicWsUrl: string | undefined;
  requireToken: boolean;
}

/**
 * Resolve bind host, HTTP port, public URLs, and the token-required flag
 * from CLI opts + env vars. The WS server shares the HTTP port (single
 * port design), so only one port is resolved. Auto-advances past taken
 * ports unless `WEBUI_STRICT_PORT` is set.
 */
export async function resolvePorts(opts: {
  surface?: 'webui' | 'simpleui' | undefined;
  wsHost?: string | undefined;
  httpPort?: number | undefined;
  webuiPort?: number | undefined;
  port?: number | undefined;
  publicUrl?: string | undefined;
  publicWsUrl?: string | undefined;
  requireToken?: boolean | undefined;
}): Promise<ResolvedPorts> {
  const surface = opts.surface ?? 'webui';
  const surfaceDefaults = surface === 'simpleui' ? { http: 3466 } : { http: 3456 };
  const wsHost = opts.wsHost ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const requestedHttpPort =
    opts.httpPort ??
    opts.webuiPort ??
    opts.port ??
    Number.parseInt(
      process.env['WEBUI_PORT'] ?? process.env['PORT'] ?? String(surfaceDefaults.http),
      10,
    );
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');

  const strictPort = isStrictPort();
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    httpPort = await findFreePort(wsHost, requestedHttpPort);
    if (httpPort !== requestedHttpPort) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'webui.port_reassigned',
          protocol: 'HTTP',
          requested: requestedHttpPort,
          assigned: httpPort,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }
  return { wsHost, httpPort, publicUrl, publicWsUrl, requireToken };
}

// ── Session start payload ───────────────────────────────────────────────

interface SessionStartPayloadGetters {
  getConfig(): Config;
  getSessionId(): string;
  getProjectRoot(): string;
  getWorkingDir(): string;
  getModeId(): string;
  getContextMode(): string;
  getNeedsSetup(): boolean;
  modelsRegistry: ModelsRegistry;
  /**
   * Resolve a session's own Context. Each WebUI tab runs its own session with
   * its own model, mode and context strategy; without this the payload would
   * describe the runtime's current session for every tab.
   */
  getSessionContext?: ((sessionId: string) => SessionRuntimeContext | undefined) | undefined;
}

/** The slice of a session Context this payload reads. */
interface SessionRuntimeContext {
  model?: string | undefined;
  provider?: { id?: string | undefined } | undefined;
  session?: { startedAt?: string | undefined } | undefined;
  meta?: Record<string, unknown> | undefined;
}

/**
 * Build a factory that produces the rich session.start payload from current
 * runtime state. Reads live values through getters so post-/new, post-resume,
 * and post-model.switch all broadcast the same shape.
 */
/** Read a string value from a session Context's meta bag, if present. */
function readSessionMeta(ctx: SessionRuntimeContext | undefined, key: string): string | undefined {
  const value = ctx?.meta?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function createSessionStartPayload(g: SessionStartPayloadGetters): (
  overrides?: Record<string, unknown>,
) => Promise<{
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
  protocolVersion: number;
  protocolCapabilities: string[];
  needsSetup?: boolean | undefined;
  reasoningEffortLevels?: string[] | undefined;
  /** Tri-state effort-support signal (see SessionLaneData.effortSupported). */
  effortSupported?: boolean | undefined;
  /** Project-wide effort — display-only hint for the composer's auto option. */
  projectReasoningEffort?: string | undefined;
  [key: string]: unknown;
}> {
  return async (overrides?: Record<string, unknown>) => {
    const globalConfig = g.getConfig();
    // Which session is this payload describing? With four tabs live, the
    // runtime's own "current" session is frequently NOT the one being
    // reported on (a model switch in a background tab, a resume that
    // answers a different tab), so the target is taken from the overrides
    // and its own runtime values win over the global defaults.
    const targetSessionId =
      typeof overrides?.['sessionId'] === 'string' && overrides['sessionId']
        ? (overrides['sessionId'] as string)
        : g.getSessionId();
    const sessionCtx = g.getSessionContext?.(targetSessionId);
    const startedAt =
      typeof sessionCtx?.session?.startedAt === 'string' && sessionCtx.session.startedAt.length > 0
        ? sessionCtx.session.startedAt
        : undefined;
    const config = {
      ...globalConfig,
      provider: sessionCtx?.provider?.id ?? globalConfig.provider,
      model: sessionCtx?.model ?? globalConfig.model,
    };
    let maxContext = 0;
    let inputCost = 0;
    let outputCost = 0;
    let cacheReadCost = 0;
    let reasoningEffortLevels: string[] | undefined;
    let effortSupported: boolean | undefined;
    try {
      const m = await resolveProviderModelMetadata(
        g.modelsRegistry,
        config.provider,
        config.model,
        config.providers?.[config.provider],
      );
      maxContext = m?.capabilities?.maxContext ?? 0;
      const rc = m?.capabilities.reasoningConfig;
      if (rc?.effortSupported && rc.effortLevels?.length) {
        reasoningEffortLevels = rc.effortLevels;
      }
      // Tri-state passthrough: undefined = undocumented vocabulary, false =
      // the model documents that it has no effort control. Never coerce.
      effortSupported = rc?.effortSupported;
      if (!maxContext) {
        try {
          const provider = await (
            g.modelsRegistry as {
              getProvider(
                id: string,
              ): Promise<
                { models: Array<{ id: string; limit?: { context?: number } }> } | undefined
              >;
            }
          ).getProvider(config.provider);
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
      protocolVersion: number;
      protocolCapabilities: string[];
      needsSetup?: boolean | undefined;
      reasoningEffortLevels?: string[] | undefined;
      effortSupported?: boolean | undefined;
      projectReasoningEffort?: string | undefined;
      [key: string]: unknown;
    } = {
      sessionId: targetSessionId,
      ...(startedAt ? { startedAt } : {}),
      model: config.model,
      provider: config.provider,
      maxContext,
      inputCost,
      outputCost,
      cacheReadCost,
      projectName: path.basename(projectRoot) || projectRoot,
      projectRoot,
      cwd: g.getWorkingDir(),
      // Mode and context strategy are per-session too: both are stamped on
      // the session's own Context meta when its tab changes them, and only
      // fall back to the global default for a session that never did.
      mode: readSessionMeta(sessionCtx, 'modeId') ?? g.getModeId(),
      contextMode: readSessionMeta(sessionCtx, 'contextWindowMode') ?? g.getContextMode(),
      ...protocolAdvertisement(),
      ...(overrides ?? {}),
    };
    if (reasoningEffortLevels) result.reasoningEffortLevels = reasoningEffortLevels;
    if (effortSupported !== undefined) result.effortSupported = effortSupported;
    // Display-only hint: the project-wide effort the composer's auto option
    // follows. Read from the LIVE global config, not the session meta — a
    // tab that picked 'auto' has no concrete value of its own to show.
    const projectReasoningEffort = (
      globalConfig.modelRuntime as { reasoning?: { effort?: string } } | undefined
    )?.reasoning?.effort;
    if (typeof projectReasoningEffort === 'string' && projectReasoningEffort !== 'auto') {
      result.projectReasoningEffort = projectReasoningEffort;
    }
    if (g.getNeedsSetup()) result.needsSetup = true;
    return result;
  };
}

// ── WebSocket servers ───────────────────────────────────────────────────

interface WsServerResult {
  wssPrimary: WebSocketServer;
  wssSecondary: WebSocketServer | null;
  wsToken: string;
  clients: Map<WebSocket, ConnectedClient>;
}

/**
 * Attach a WebSocket server to an HTTP server (shared-port design).
 * Creates the primary WS server attached to the given HTTP server.
 * IPv6 loopback coverage is provided by the HTTP server's dual-stack
 * listen (see start-webui.ts); no separate WS secondary is created.
 * Returns the WS server, the resolved auth token, and the clients map.
 */
export function createWsServers(
  httpServer: import('node:http').Server,
  ports: ResolvedPorts,
  accessToken: string | undefined,
): WsServerResult {
  const wsToken = resolveAuthToken(accessToken);
  console.log('[WebUI] WS auth token ready');
  const publicHostnames = [ports.publicUrl, ports.publicWsUrl]
    .map((value) => {
      if (!value) return undefined;
      try {
        return new URL(value).hostname;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));

  const verifyClient = (info: {
    origin: string;
    secure: boolean;
    req: import('node:http').IncomingMessage;
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
      // WS-003 opt-out for the Vite dev loop only (app and WS server cannot
      // share a port). Off unless explicitly requested — see ws-auth.ts.
      allowCrossPortLoopbackCookie: process.env['WRONGSTACK_WEBUI_DEV_CROSS_PORT_WS'] === '1',
    });

  // 20 MiB to leave headroom for image attachments (base64-inflated) in
  // user_message payloads. Keep in sync with the CLI webui-server's
  // maxPayload — both servers speak the same protocol.
  const WS_MAX_PAYLOAD = 20 * 1024 * 1024;
  const wssPrimary = new WebSocketServer({
    server: httpServer,
    verifyClient,
    maxPayload: WS_MAX_PAYLOAD,
    // Send a ping every 15s to keep idle connections alive. Without this,
    // network equipment (routers, proxies, NAT gateways) may drop idle TCP
    // connections, causing the browser to see a close event and show the
    // "reconnecting" banner. The browser responds with a pong automatically
    // (the WebSocket API handles this at the transport level).
    pingInterval: 15_000,
    // Wait 5s for a pong before considering the connection dead. A client
    // that hasn't responded to 3 consecutive pings in a row (45s total
    // quiet) is almost certainly unreachable — close the socket so the
    // client can reconnect cleanly rather than hanging indefinitely.
    pingTimeout: 5_000,
  } as ConstructorParameters<typeof WebSocketServer>[0]);
  // IPv6 loopback secondary: when binding to 127.0.0.1, we also listen on
  // [::1] so Chrome/Edge on Windows (which resolve localhost to IPv6 first)
  // can connect without ECONNREFUSED. The HTTP server handles this via
  // dual-stack listen — see start-webui.ts.
  const wssSecondary = null;
  const clients = new Map<WebSocket, ConnectedClient>();
  return { wssPrimary, wssSecondary, wsToken, clients };
}

// ── Event arming + WS error handlers ────────────────────────────────────

/**
 * Wire setupEvents (the once-only event→WS-broadcast bridge) behind a
 * listening-callback guard, and attach WS server error handlers. Returns
 * the dispose + fleet-broadcast functions.
 */
export function armEvents(
  wssPrimary: WebSocketServer,
  wssSecondary: WebSocketServer | null,
  wsHost: string,
  httpPort: number,
  setupInput: Parameters<typeof setupEvents>[0],
  watcherMetrics: FileWatcherMetrics,
): {
  arm: (label: string) => void;
  getDispose: () => (() => void) | null;
  getFleetBroadcast: () => (() => Promise<void>) | null;
} {
  let eventsArmed = false;
  let disposeEvents: (() => void) | null = null;
  let fleetBroadcast: (() => Promise<void>) | null = null;

  const arm = (label: string): void => {
    if (eventsArmed) return;
    eventsArmed = true;
    console.log(`[WebUI] Backend ready (${label})`);
    disposeEvents = setupEvents({
      ...setupInput,
      watcherMetrics,
      onFleetBroadcaster: (fn) => {
        fleetBroadcast = fn;
      },
    });
  };

  wssPrimary.on('listening', () => arm(`${wsHost}:${httpPort}`));
  wssPrimary.on('error', (err) => {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'webui.ws_server_error',
        host: wsHost,
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
  });
  if (wssSecondary) {
    wssSecondary.on('listening', () => arm(`::1:${httpPort}`));
    wssSecondary.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL') {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.ipv6_unavailable',
            code: err.code,
            message: err.message,
            timestamp: new Date().toISOString(),
          }),
        );
      } else {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'webui.ws_server_error',
            host: '::1',
            message: err.message,
            timestamp: new Date().toISOString(),
          }),
        );
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
 * standalone server serve the webui assets when both packages are installed,
 * while also allowing embedded callers (e.g. the desktop app) to pass an exact
 * path so they don't depend on module-resolution layout.
 */
function resolveWebuiDistDir(fromUrl: string, explicitDistDir?: string | undefined): string {
  if (explicitDistDir) return path.resolve(explicitDistDir);
  try {
    const requireFromHere = createRequire(fromUrl);
    const serverEntry = requireFromHere.resolve('@wrongstack/webui');
    return path.dirname(serverEntry); // .../dist
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
  onTechStackEvent?:
    | ((event: import('./techstack-handlers.js').TechStackEvent) => void)
    | undefined;
  /** Live provider access for TechStack's LLM research stage. */
  getLlm?:
    | (() => { provider: import('@wrongstack/core/types').Provider; model: string } | undefined)
    | undefined;
  executePackageOperation?: import('./techstack-handlers.js').TechStackHandlerDeps['executePackageOperation'];
  distDir?: string | undefined;
  /** Optional pre-built intake service (tests/embeds). Defaults to a fresh
   *  per-project service backed by `projectRequirementIntakes`. */
  intakeService?: import('@wrongstack/requirement-intake').RequirementIntakeService | undefined;
  /**
   * Optional vector-memory store. When provided, the four
   * `/api/vector-memory/{status,search,store,store/:id}` endpoints become
   * active. When omitted, the routes respond with `{ enabled: false }` or
   * 503 — a non-CLI webui-server host stays on its existing surface with
   * zero behavior change.
   */
  getVectorMemoryStore?:
    | (() => import('@wrongstack/vector-memory').VectorMemoryStore | undefined)
    | undefined;
  /** Model cache directory for the vector-memory provider. */
  vectorMemoryModelCacheDir?: string | undefined;
}): import('node:http').Server {
  const intakeService =
    opts.intakeService ??
    createProjectIntakeService({ projectRoot: opts.projectRoot, globalRoot: opts.globalRoot });
  const httpServer = createHttpServer({
    host: opts.wsHost,
    port: opts.httpPort,
    distDir: resolveWebuiDistDir(import.meta.url, opts.distDir),
    publicWsUrl: opts.publicWsUrl,
    globalRoot: opts.globalRoot,
    apiToken: opts.wsToken,
    requireToken: opts.requireToken,
    watcherMetrics: opts.watcherMetrics,
    onFleetPing: opts.onFleetPing,
    onTechStackEvent: opts.onTechStackEvent,
    getLlm: opts.getLlm,
    executePackageOperation: opts.executePackageOperation,
    projectRoot: opts.projectRoot,
    intakeService,
    ...(opts.getVectorMemoryStore ? { getVectorMemoryStore: opts.getVectorMemoryStore } : {}),
    ...(opts.vectorMemoryModelCacheDir
      ? { vectorMemoryModelCacheDir: opts.vectorMemoryModelCacheDir }
      : {}),
  });
  return httpServer;
}

interface ShutdownDeps {
  flushSession: () => Promise<void>;
  clients: () => IterableIterator<WebSocket>;
  servers: Array<import('node:http').Server | WebSocketServer>;
  /**
   * Fires **before** any HTTP/WS servers close. Use this for cleanup that must
   * finish while the network is still up — e.g. telling a Kanban supervisor
   * to flush its periodic tick so no in-flight `kanban.*` broadcast races a
   * `WebSocketServer.close()`.
   */
  onPreShutdown?: () => Promise<void> | void;
  onShutdown: () => Promise<void> | void;
}

export function registerShutdown(deps: ShutdownDeps): () => void {
  return registerShutdownHandlers({
    flushSession: deps.flushSession,
    clients: deps.clients,
    servers: deps.servers,
    onPreShutdown: deps.onPreShutdown,
    onShutdown: deps.onShutdown,
  });
}
