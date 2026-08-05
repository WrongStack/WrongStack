/**
 * CLI embedded WebUI server — the backend behind `wrongstack --webui`.
 *
 * `runWebUI(opts)` boots a WebSocket bridge (and, when the webui package
 * is built, the static HTTP frontend) over the *same* agent/events/
 * session instances the REPL and eternal-autonomy loop use, then routes
 * browser messages through a `handleMessage` switch.
 *
 * Most self-contained concerns live under `webui-server/*`; this file now
 * assembles CLI-owned instances, route contexts, WebSocket lifecycle, and the
 * embedded shared router.
 *
 * Public surface: `runWebUI` plus WS message shapes.
 */
import type { Server as HttpServer } from 'node:http';
import { findPackageJSON } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { TOKENS } from '@wrongstack/core/kernel';
import { createCompatibilityTrustBoundary, DefaultSecretScrubber } from '@wrongstack/core/security';
import { SkillInstaller } from '@wrongstack/core/skills';
import { PromptUsageStore, watchProviderConfig } from '@wrongstack/core/storage';
import type { ProviderConfig } from '@wrongstack/core/types';
import {
  resolveWstackPaths,
  startSharedHeapWatchdog,
  wstackGlobalRoot,
} from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  type BrainHandlerContext,
  buildSddWizardDeps,
  buildWebUIAccessUrl,
  type CustomModeStore,
  createCustomModeStore,
  createEmbeddedMessageRouter,
  createEmbeddedProviderOperations,
  createMailboxRouteHandlers,
  type DesignContext,
  type EmbeddedAgentConfigContext,
  type EmbeddedConversationContext,
  type EmbeddedProjectContext,
  type EmbeddedProviderContext,
  type EmbeddedSessionContext,
  envFlag,
  findFreePort,
  GoalWebSocketHandler,
  type IntrospectionRouteContext,
  type PendingConfirm,
  type PrefsHandlerContext,
  type PromptsContext,
  resolveAuthToken,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  type SkillsContext,
  SpecsWebSocketHandler,
  TerminalWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui-server';
import { WebSocket, WebSocketServer } from 'ws';
import { createWebuiClientRegistration } from './webui-server/client-registration.js';
import type {
  WSClientMessage as EmbeddedWSClientMessage,
  WSServerMessage as EmbeddedWSServerMessage,
} from './webui-server/contracts.js';
export type WSClientMessage = EmbeddedWSClientMessage;
export type WSServerMessage = EmbeddedWSServerMessage;

import {
  type ConnectedClient,
  createConnectionHandler,
} from './webui-server/connection-handler.js';
import { createCliKanbanHostRoutes } from './webui-server/kanban-host-adapter.js';
import { createKanbanRunMirror } from './webui-server/kanban-run-mirror.js';
import { createKanbanSupervisor } from './webui-server/kanban-supervisor.js';
import {
  announceWebuiReady,
  createWebuiShutdown,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
} from './webui-server/lifecycle.js';
import { startDeferredHttpListen, startIpv6LoopbackProxy } from './webui-server/listen-helpers.js';
import { consoleLogger } from './webui-server/logger-shim.js';
import { createNodePtyLoader } from './webui-server/node-pty-loader.js';
import { createPrefsSeeding, seedConfigToMeta } from './webui-server/prefs-seeding.js';
import {
  createProviderConfigStore,
  getVault,
  loadSavedProviders,
} from './webui-server/provider-config.js';
import { createSessionStartPayloadBuilder } from './webui-server/session-start-payload.js';
import { createSetupEvents } from './webui-server/setup-events.js';
import { startStaticServe } from './webui-server/static-serve.js';
import { createStreamCoalescer } from './webui-server/stream-coalescer.js';
import { startBoundedTerminalLogView } from './webui-server/terminal-log-view.js';

import type { CliWebUIOptions } from './webui-server-options.js';

export type { CliWebUIOptions } from './webui-server-options.js';
export async function runWebUI(opts: CliWebUIOptions): Promise<void> {
  const trustBoundary =
    opts.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'cli-webui-trusted-host-compat-v1' });
  const host = opts.host ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');
  const surface = opts.surface ?? 'webui';
  const surfaceDefaults = surface === 'simpleui' ? { http: 3466 } : { http: 3456 };
  const requestedHttpPort = opts.httpPort ?? opts.port ?? surfaceDefaults.http;
  // Auto-advance past busy ports (unless WEBUI_STRICT_PORT) so this works
  // alongside other WebUI instances. WS shares the HTTP port (single-port
  // design), so only one port is resolved.
  const strictPort =
    process.env['WEBUI_STRICT_PORT'] === '1' || process.env['WEBUI_STRICT_PORT'] === 'true';
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    httpPort = await findFreePort(host, requestedHttpPort);
  }
  const wsPort = httpPort; // shared port — kept for onListening/announce compat
  const globalRoot = opts.globalConfigPath
    ? path.dirname(opts.globalConfigPath)
    : wstackGlobalRoot();
  // Keep older embedders/tests that only provide globalConfigPath working.
  // The CLI supplies profileConfigPath, but treating it as the sole source
  // caused startup to reject before the HTTP/WS server could report errors.
  const profileConfigPath =
    opts.profileConfigPath ?? opts.globalConfigPath ?? path.join(globalRoot, 'config.json');
  // Per-connection message budget, in non-keepalive messages per 60s.
  //
  // WS-029: this was OFF by default because the limiter "counted pings/list
  // calls too" and tripped during normal use. That cause is fixed at the
  // source — keepalives are exempt and the charge happens after decode (see
  // `RATE_LIMIT_EXEMPT_TYPES` in connection-lifecycle.ts) — so a default is
  // now safe. 600/60s is far above interactive use and still bounds a runaway
  // client or a hostile local page. `WEBUI_RATE_LIMIT=0` opts out.
  const rateLimitMax = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '600', 10);
  const clients = new Map<WebSocket, ConnectedClient>();
  // Pending permission confirmations keyed by toolUseId. When the agent emits
  // tool.confirm_needed, we stash its resolver here and forward the prompt to
  // the browser; the client's tool.confirm_result resolves it. This is what
  // makes approvals appear in the WebUI instead of the terminal.
  const pendingConfirms = new Map<string, PendingConfirm>();
  const secretScrubber = new DefaultSecretScrubber();
  let abortController: AbortController | null = null;
  // Per-WebSocket abort controllers. The legacy single-slot `abortController`
  // above is the project-switch path's view (it always aborts the in-flight
  // run, no matter which socket initiated the switch) — kept for behavior
  // parity. The per-socket map scopes `case 'abort'` and `handleUserMessage`
  // so a second browser tab or a rapid same-tab abort cannot kill another
  // socket's run. Both are kept in sync.
  const abortControllers = new Map<WebSocket, AbortController>();

  const profileDir = path.dirname(profileConfigPath);
  // Custom context modes are profile-scoped and shared with the standalone server.
  let customModeStoreP: Promise<CustomModeStore> | null = null;
  const getCustomModeStore = (): Promise<CustomModeStore> => {
    customModeStoreP ??= (async () => {
      const store = createCustomModeStore(profileDir);
      await store.load();
      return store;
    })();
    return customModeStoreP;
  };

  // Goal handler — manages Goal lifecycle via WS messages.
  // Initialized here so it can be used in the connection handler and message switch.
  const goalStoreDir = opts.projectRoot
    ? path.join(opts.projectRoot, '.wrongstack', 'goal')
    : path.join(os.tmpdir(), '.wrongstack', 'goal');
  // KanbanRunMirror — projects live SDD (via the shared bus) and Goal (via
  // the handler callback below) runs into kanban boards, so the kanban view is
  // the unified live surface. Needs a project root (kanban boards are project-scoped).
  const kanbanRunMirror = opts.projectRoot
    ? createKanbanRunMirror({
        projectRoot: opts.projectRoot,
        events: opts.events,
        broadcast,
        log: (m) => consoleLogger.info(m),
      })
    : null;
  const kanbanSupervisor = opts.projectRoot
    ? createKanbanSupervisor({
        projectRoot: opts.projectRoot,
        broadcast,
        ...(opts.onKanbanDispatch ? { dispatchTask: opts.onKanbanDispatch } : {}),
        log: (message) => consoleLogger.info(message),
      })
    : null;
  const stopKanbanSupervisorMemoryStats = kanbanSupervisor
    ? startSharedHeapWatchdog({
        collectStats: () => {
          const stats = kanbanSupervisor.getStats();
          return {
            kanbanSupervisorSnapshots: stats.snapshots,
            kanbanSupervisorScheduledBoards: stats.scheduledBoards,
            kanbanSupervisorAgentCooldowns: stats.agentCooldowns,
            kanbanSupervisorRunningAgents: stats.runningAgents,
          };
        },
      })
    : undefined;
  const goalHandler = new GoalWebSocketHandler(
    opts.agent,
    opts.agent.ctx as Context,
    consoleLogger,
    goalStoreDir,
    opts.events,
    opts.projectRoot,
    kanbanRunMirror ? (graphId, state) => kanbanRunMirror.onGoalState(graphId, state) : undefined,
  );
  const worktreeHandler = new WorktreeWebSocketHandler(opts.events, consoleLogger);

  const loadNodePtyViaWebui = createNodePtyLoader(import.meta.url, consoleLogger);
  const terminalHandler = new TerminalWebSocketHandler(
    () => (opts.agent.ctx as Context).cwd ?? opts.projectRoot ?? process.cwd(),
    consoleLogger,
    loadNodePtyViaWebui as ConstructorParameters<typeof TerminalWebSocketHandler>[2],
    undefined,
    trustBoundary,
  );

  // Specs handler — FORGE-style dependency board over the shared per-project
  // SDD stores (where /sdd persists specs + task graphs).
  const specsPaths = opts.projectRoot
    ? resolveWstackPaths({ projectRoot: opts.projectRoot })
    : null;
  const specsHandler = new SpecsWebSocketHandler(
    specsPaths?.projectSpecs ?? path.join(os.tmpdir(), '.wrongstack', 'specs'),
    specsPaths?.projectTaskGraphs ?? path.join(os.tmpdir(), '.wrongstack', 'task-graphs'),
  );

  // SDD live board handler — same process as the run, so it streams instantly
  // off the shared EventBus (no disk polling) and steers via Kanban IPC.
  // Lifecycle deps enable Clean / Rollback / Destroy from the WebUI (same as
  // standalone server) — without them those buttons only report "unavailable".
  const sddBoardHandler = new SddBoardWebSocketHandler(
    specsPaths?.projectSddBoards ?? path.join(os.tmpdir(), '.wrongstack', 'sdd-boards'),
    opts.events,
    specsPaths && opts.projectRoot
      ? {
          projectRoot: opts.projectRoot,
          paths: {
            projectSpecs: specsPaths.projectSpecs,
            projectTaskGraphs: specsPaths.projectTaskGraphs,
            projectSddSession: specsPaths.projectSddSession,
            projectSddBoards: specsPaths.projectSddBoards,
          },
        }
      : undefined,
    { trustBoundary, logger: consoleLogger },
  );

  // SDD wizard — interactive "New SDD Project" flow. Available only when the
  // host threaded its director-backed subagent factory (so the run uses the
  // same fleet as `/sdd execute`). The interview turns + run share that factory.
  const sddWizardHandler =
    opts.sddSubagentFactory && specsPaths
      ? new SddWizardWebSocketHandler(
          buildSddWizardDeps({
            agent: opts.agent,
            events: opts.events,
            projectRoot: opts.projectRoot ?? process.cwd(),
            subagentFactory: opts.sddSubagentFactory,
            // Failure supervisor parity with /sdd execute — omit only when
            // the host never bound a BrainArbiter.
            ...(opts.brain ? { brain: opts.brain } : {}),
            paths: {
              projectSpecs: specsPaths.projectSpecs,
              projectTaskGraphs: specsPaths.projectTaskGraphs,
              projectSddBoards: specsPaths.projectSddBoards,
              projectDir: specsPaths.projectDir,
              projectSddSession: specsPaths.projectSddSession,
            },
          }),
        )
      : null;

  // ── Settings parity with the TUI ─────────────────────────────────────
  // Seed agent.ctx.meta from config.json on startup, then snapshot/persist
  // via the prefs handlers. Extracted to prefs-seeding.ts (PR 8 of Issue #30).
  await seedConfigToMeta(opts);
  if (typeof opts.agent.ctx?.meta?.['yolo'] === 'boolean') {
    opts.onYoloSwitch?.(opts.agent.ctx.meta['yolo']);
  }

  const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);

  // Captured once at startup so stats.get can report elapsed time since the
  // session was opened, rather than the hardcoded 0 it used to send.
  const sessionStartedAt = Date.now();

  // session.start payload builder — cost rates + max-context enrichment.
  // PR 11 of Issue #30: extracted to `./webui-server/session-start-payload.ts`.
  const buildSessionStartPayload = createSessionStartPayloadBuilder(opts);

  // ── Client (REPL/TUI/WebUI) registration ─────────────────────────────────
  // Mailbox presence + HQ telemetry for this WebUI instance. PR 10 of
  // Issue #30: extracted to `./webui-server/client-registration.ts`.
  const { register: registerWebuiClient, unregister: unregisterWebuiClient } =
    createWebuiClientRegistration({
      projectRoot: opts.projectRoot,
      appConfig: opts.appConfig,
      events: opts.events,
      hqSessionId: opts.session.id,
      getSessionId: () => opts.agent.ctx.session?.id ?? opts.session.id,
      // Two-way HQ control for the WebUI client: steer/btw/queue/broadcast
      // land in the project mailbox (the WebUI's agent reads it like any
      // other surface), and abort tears down every in-flight run on this
      // instance. Without this block the WebUI would be HQ-invisible to the
      // Control tab — telemetry only.
      hqControl: {
        interruptLeader: () => {
          let aborted = false;
          if (abortController) {
            abortController.abort();
            abortController = null;
            aborted = true;
          }
          for (const c of abortControllers.values()) {
            c.abort();
            aborted = true;
          }
          abortControllers.clear();
          return aborted;
        },
        allowRunCommand: () => opts.hqAllowExec === true,
      },
    });

  // Register immediately (fire-and-forget so it doesn't block server startup)
  registerWebuiClient();

  // Generate auth token for WS connections and HTTP /ws-auth endpoint.
  // The token is passed to the frontend via the URL query param, which the
  // frontend then exchanges for an HttpOnly cookie via /ws-auth?token=...
  // This closes C-598 (query-string token exposure) after the first request.
  const wsToken = resolveAuthToken(opts.accessToken);
  const publicHostnames = [publicUrl, publicWsUrl]
    .map((value) => {
      if (!value) return undefined;
      try {
        return new URL(value).hostname;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
  const accessUrl = buildWebUIAccessUrl({
    host,
    port: httpPort,
    token: wsToken,
    publicUrl,
  });

  // Serve the React frontend over HTTP so `wrongstack --webui` is a one-command
  // launch (open the printed URL) instead of only a WS bridge. The dist
  // discovery + HTTP server bring-up live in
  // `webui-server/static-serve.ts`; we just hand it the options and
  // wire the open-browser callback on top. If the webui package
  // isn't built, `startStaticServe` returns null and we degrade
  // gracefully to WS-only (the original behavior).
  // Captured from the status block below so `POST /api/fleet/ping` can trigger
  // an immediate fleet re-broadcast (push-on-write from a TUI/REPL).
  let fleetBroadcastCli: (() => Promise<void>) | null = null;
  const httpServer = await startStaticServe({
    host,
    httpPort,
    globalRoot,
    distDir: opts.frontendDistDir,
    ensureDistDeps: {
      resolvePackageJson: (id) => {
        const packageJson = findPackageJSON(id, import.meta.url);
        if (!packageJson) throw new Error(`Package not found: ${id}`);
        return packageJson;
      },
    },
    onFleetPing: () => {
      void fleetBroadcastCli?.();
    },
    onTechStackEvent: (event) => broadcast(event),
    // Read through the live agent context so a mid-session model switch or a
    // credential hot-reload takes effect on the next analyze.
    getLlm: () =>
      opts.agent.ctx.provider && opts.agent.ctx.model
        ? { provider: opts.agent.ctx.provider, model: opts.agent.ctx.model }
        : undefined,
    projectRoot: opts.projectRoot,
    publicWsUrl,
    apiToken: wsToken,
    requireToken,
    // SimpleUI only: defer listen until after the WebSocketServer is
    // attached, so a WS upgrade request cannot arrive between listen()
    // and the WS handler registration.
    deferListen: surface === 'simpleui',
  });

  // 20 MiB to leave headroom for image attachments (base64-inflated) in
  // user_message payloads. Keep in sync with webui-server's WS_MAX_PAYLOAD —
  // both servers speak the same protocol and must accept the same messages.
  //
  // Single-port design: when the HTTP server is available, the WS server
  // attaches to it via { server: httpServer } so a single listen() binds
  // both the HTTP frontend and the WS upgrade handler on the same port.
  // When the frontend isn't built (httpServer === null), fall back to a
  // standalone WS listener on the same port.
  //
  // For SimpleUI, deferListen suppressed the internal listen() so we call
  // it here after creating the WSS — preventing the WS upgrade race.
  const wss = httpServer
    ? new WebSocketServer({ server: httpServer.server, maxPayload: 20 * 1024 * 1024 })
    : new WebSocketServer({ port: httpPort, host, maxPayload: 20 * 1024 * 1024 });

  // SimpleUI: start listening now that the WS handler is registered.
  // Await with an error handler so EADDRINUSE (race between findFreePort
  // and this listen) propagates as a rejected promise instead of a silent
  // crash — the caller's .catch handler (dispatch-webui.ts:349) reports
  // the error gracefully.
  if (httpServer && surface === 'simpleui') {
    await startDeferredHttpListen({
      server: httpServer.server,
      host,
      httpPort,
      logger: consoleLogger,
    });
  }

  // ── IPv6 loopback secondary listen ──────────────────────────────────────
  // Chrome/Edge on Windows resolve `localhost` to [::1] BEFORE 127.0.0.1. A
  // v4-only bind then makes the WebSocket upgrade to ws://localhost:PORT fail
  // with ECONNREFUSED: the HTTP page still loads (browsers retry v4 for the
  // navigation) but the WS does NOT retry, so SimpleUI/WebUI shows "WebSocket
  // connection failed" and never comes up.
  //
  // A Node http.Server binds a single address — calling `.listen()` twice on
  // the already-listening primary throws ERR_SERVER_ALREADY_LISTEN. So bring
  // up the IPv6 loopback with a SECOND server that forwards its HTTP requests
  // and WS upgrades onto the primary; the shared WebSocketServer (attached via
  // {server: httpServer.server}) then serves both loopback families, so
  // `localhost` AND `127.0.0.1` work. Best-effort: EAFNOSUPPORT/EADDRNOTAVAIL/
  // EADDRINUSE (no usable IPv6 loopback, or already bound) must never take down
  // the authoritative v4 listener.
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

  // Record this instance so it shows up in `wstack --webui --list` /
  // ~/.wrongstack/webui-instances.json alongside standalone instances.
  const registryBaseDir = globalRoot;
  if (opts.projectRoot) {
    registerWebuiInstance({
      pid: process.pid,
      surface,
      host,
      httpPort,
      publicUrl,
      projectRoot: opts.projectRoot,
      startedAt: new Date().toISOString(),
      registryBaseDir,
      // Lets a same-project TUI/REPL authenticate `POST /api/fleet/ping` now
      // that the API requires a token on every bind (H3).
      authToken: wsToken,
    });
  }
  // Auth token is delivered through the printed first-load URL and then
  // exchanged for an HttpOnly cookie by /ws-auth.

  // Subscribe to events once
  const eventUnsubscribers: Array<() => void> = [];

  const currentSessionId = (): string => opts.agent.ctx.session?.id ?? opts.session.id;
  const sessionPayload = <T extends Record<string, unknown>>(
    payload: T,
  ): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };

  // Coalesce high-volume live events on the server before they hit every
  // connected browser tab. PR 9 of Issue #30: extracted to
  // `./webui-server/stream-coalescer.ts`.
  const {
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
  } = createStreamCoalescer({ broadcast, sessionPayload });

  // ── Event arming ─────────────────────────────────────────────────────────
  // Every EventBus → browser broadcast subscription (incl. the fleet
  // concurrency gauge state). PR 12 of Issue #30: extracted to
  // `./webui-server/setup-events.ts`.
  const setupEvents = createSetupEvents({
    events: opts.events,
    agent: opts.agent,
    subscribeEternalIteration: opts.subscribeEternalIteration,
    broadcast,
    sessionPayload,
    currentSessionId,
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
    pendingConfirms,
    secretScrubber,
    getClients: () => clients,
    eventUnsubscribers,
    globalConfigPath: path.join(globalRoot, 'config.json'),
    onFleetBroadcaster: (fn) => {
      fleetBroadcastCli = fn;
    },
    ...(opts.getFleetBudget ? { getFleetBudget: opts.getFleetBudget } : {}),
  });

  // Shared state for the extracted ws-handler groups (PR 5 of #30).
  // `send`/`broadcast` are hoisted function declarations, so capturing
  // them here is safe even though they're defined further down.
  const wsHandlerCtx: EmbeddedProviderContext = {
    providerStore: createProviderConfigStore(
      profileConfigPath,
      // Use the in-memory merged config providers so the WebUI sees the
      // same provider list the agent uses. Without this, providers stored
      // only in the project-local config (config.local.json) would be
      // invisible to the WebUI's saved-providers panel because the store
      // reads exclusively from the global config file.
      () => (opts.appConfig?.providers as Record<string, ProviderConfig> | undefined) ?? {},
    ),
    modelsRegistry: opts.modelsRegistry,
    send,
    broadcast,
    log: (m) => console.log(m),
  };
  const embeddedProviderOperations = createEmbeddedProviderOperations(wsHandlerCtx);

  // Hot-reload provider credentials when config.json changes on disk (another
  // terminal's `wstack auth`, a provider panel in a different window, or a
  // manual edit). Rebuild the live agent's provider so the next message uses
  // the new key without a server restart, and re-broadcast the saved-providers
  // projection so every connected panel re-renders. Mirrors the live-swap that
  // `handleModelSwitch` already does. Escape hatch: WRONGSTACK_DISABLE_CONFIG_WATCH=1.
  //
  // Watches the ACTIVE PROFILE config (~/.wrongstack/profiles/<name>/config.json)
  // where all user settings, providers, and routing configs live.
  const watchConfigPath = profileConfigPath;
  let credentialWatcherClose: (() => void) | undefined;
  if (watchConfigPath && process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    let lastActiveCfg = JSON.stringify(
      opts.appConfig?.providers?.[opts.agent.ctx.provider.id] ?? null,
    );
    let lastUiLocale = opts.appConfig?.uiLocale;
    const watcher = watchProviderConfig(
      watchConfigPath,
      // Vault key lives at ~/.wrongstack/.key (derived from globalConfigPath),
      // not inside the profile directory — resolve via global root to stay correct.
      getVault(opts.globalConfigPath),
      (snapshot) => {
        const hadFallbackBridge = Boolean(opts.appConfig?.fallbackBridge?.trim());
        // Best-effort: refresh the in-memory providers ref the panel reads from
        // (skipped silently when appConfig is frozen — the broadcast below still
        // pushes the fresh map, so panels stay correct either way).
        try {
          if (opts.appConfig && !Object.isFrozen(opts.appConfig)) {
            opts.appConfig.providers = snapshot.providers;
            if (snapshot.uiLocale) opts.appConfig.uiLocale = snapshot.uiLocale;
            if (snapshot.fallbackBridge !== undefined) {
              opts.appConfig.fallbackBridge = snapshot.fallbackBridge;
            } else {
              delete opts.appConfig.fallbackBridge;
            }
          }
        } catch {
          /* frozen / read-only appConfig — ignore */
        }
        // Propagate routing/config changes to ConfigStore so running workers
        // pick them up (independent of the provider-credential path below).
        const routingChanged =
          snapshot.fallbackModels !== undefined ||
          snapshot.fallbackBridge !== undefined ||
          hadFallbackBridge ||
          snapshot.fallbackProfiles !== undefined ||
          snapshot.favoriteModels !== undefined ||
          snapshot.favoriteModelsOnly !== undefined ||
          snapshot.modelMatrix !== undefined ||
          snapshot.fallbackAuto !== undefined;
        if (routingChanged) {
          const configStore = opts.agent.container?.safeResolve?.(TOKENS.ConfigStore) as
            | import('@wrongstack/core/types').ConfigStore
            | undefined;
          configStore?.update({
            ...(snapshot.fallbackModels !== undefined
              ? { fallbackModels: snapshot.fallbackModels }
              : {}),
            fallbackBridge: snapshot.fallbackBridge ?? '',
            ...(snapshot.fallbackProfiles !== undefined
              ? { fallbackProfiles: snapshot.fallbackProfiles }
              : {}),
            ...(snapshot.favoriteModels !== undefined
              ? { favoriteModels: snapshot.favoriteModels }
              : {}),
            ...(snapshot.favoriteModelsOnly !== undefined
              ? { favoriteModelsOnly: snapshot.favoriteModelsOnly }
              : {}),
            ...(snapshot.modelMatrix !== undefined ? { modelMatrix: snapshot.modelMatrix } : {}),
            ...(snapshot.fallbackAuto !== undefined ? { fallbackAuto: snapshot.fallbackAuto } : {}),
          } as never);
        }
        embeddedProviderOperations.broadcastSaved(snapshot.providers);

        // Display language live-propagation: when another surface writes
        // Config.uiLocale (desktop shell, standalone WebUI, or another
        // embedded WebUI), push it through the same prefs path the frontend
        // already uses for instant i18n re-render.
        if (snapshot.uiLocale !== lastUiLocale) {
          lastUiLocale = snapshot.uiLocale;
          if (snapshot.uiLocale) {
            opts.agent.ctx.meta['uiLocale'] = snapshot.uiLocale;
            broadcast({ type: 'prefs.updated', payload: { uiLocale: snapshot.uiLocale } });
          }
        }

        const activeId = opts.agent.ctx.provider.id;
        const newCfgStr = JSON.stringify(snapshot.providers[activeId] ?? null);
        if (newCfgStr === lastActiveCfg) return; // active provider creds unchanged
        lastActiveCfg = newCfgStr;
        try {
          const newCfg = snapshot.providers[activeId] ?? {
            type: activeId,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          };
          const oldMax = opts.agent.ctx.provider.capabilities?.maxContext;
          // Keep the saved factory type (e.g. "ai-gateway") so a credential
          // hot-reload rebuilds the same transport instead of downgrading an
          // alias to a generic config-only provider.
          const prov = makeProviderFromConfig(activeId, {
            ...newCfg,
            type: newCfg.type ?? activeId,
          });
          // Key-only change keeps the same model/context window — preserve the
          // resolved maxContext instead of falling back to the family default.
          if (oldMax != null && prov.capabilities) prov.capabilities.maxContext = oldMax;
          opts.agent.ctx.provider = prov;
          console.log(`[WebUI] Provider credentials reloaded from config.json (${activeId})`);
        } catch (err) {
          console.warn(
            `[WebUI] Credential hot-reload failed for ${activeId}: ${toErrorMessage(err)}`,
          );
        }
      },
      {
        warn: (m) =>
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'webui.config_watcher',
              message: m,
              timestamp: new Date().toISOString(),
            }),
          ),
      },
    );
    credentialWatcherClose = watcher.close;
  }

  const brainCtx: BrainHandlerContext = {
    brainSettings: opts.brainSettings,
    brainRuntime: opts.brainRuntime,
    getBrainLog: opts.getBrainLog,
    // Prefer the host-supplied arbiter; otherwise resolve the one bound
    // in the agent container (if any). Mirrors the former inline lookup.
    resolveArbiter: () =>
      opts.brain ??
      (opts.agent.container.has(TOKENS.BrainArbiter)
        ? opts.agent.container.resolve(TOKENS.BrainArbiter)
        : undefined),
    getSessionId: currentSessionId,
    send,
  };

  const introspectionConfigStore = opts.agent.container?.safeResolve?.(TOKENS.ConfigStore);
  const introspectionCtx: IntrospectionRouteContext = {
    agent: opts.agent,
    modelsRegistry: opts.modelsRegistry,
    configStore: introspectionConfigStore,
    getConfig: () => {
      const cfg = introspectionConfigStore?.get() ?? opts.appConfig;
      if (!cfg)
        throw new Error(
          'Introspection route requires a config but neither ConfigStore nor opts.appConfig is available',
        );
      return cfg;
    },
    getProjectRoot: () =>
      opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '',
    getSessionId: currentSessionId,
    getSessionStartedAt: () => sessionStartedAt,
    getModeId: () => opts.modeId ?? 'default',
    send,
  };

  // Shared skills handlers context. The CLI passes its own skillLoader; the
  // installer (backing install/uninstall/update) is constructed here the same
  // way the standalone WebUI server does. Absent skillLoader ⇒ skills feature
  // disabled and the handlers respond with an "enabled: false" payload.
  const skillsProjectRoot =
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';
  const skillsPaths = skillsProjectRoot
    ? resolveWstackPaths({
        projectRoot: skillsProjectRoot,
        globalRoot,
      })
    : undefined;
  const skillsCtx: SkillsContext = {
    skillLoader: opts.skillLoader,
    skillInstaller: opts.skillLoader
      ? new SkillInstaller({
          manifestPath: path.join(skillsPaths?.configDir ?? profileDir, 'installed-skills.json'),
          projectSkillsDir:
            skillsPaths?.inProjectSkills ?? path.join(skillsProjectRoot, '.wrongstack', 'skills'),
          globalSkillsDir: skillsPaths?.globalSkills ?? path.join(profileDir, 'skills'),
          projectHash: skillsPaths?.projectHash ?? '',
          skillLoader: opts.skillLoader,
        })
      : undefined,
    projectRoot: skillsProjectRoot,
    projectSkillsDir: skillsPaths?.inProjectSkills,
    globalSkillsDir: skillsPaths?.globalSkills,
  };

  // Prompt library context — shared handlers, one source of truth with the
  // standalone server. Absent promptLoader ⇒ handlers respond "unavailable".
  const promptsCtx: PromptsContext = {
    promptLoader: opts.promptLoader,
    promptUsage: new PromptUsageStore(
      skillsPaths?.promptUsage ?? path.join(profileDir, 'prompt-usage.json'),
    ),
  };

  // Design Studio context — same project root, live agent ctx so design.use
  // pins the active kit for the next turn.
  const designCtx: DesignContext = {
    projectRoot: skillsProjectRoot,
    agentMeta: opts.agent.ctx,
  };

  const agentConfigCtx: EmbeddedAgentConfigContext = {
    agent: opts.agent,
    modeStore: opts.modeStore,
    loadSavedProviders: () => loadSavedProviders(profileConfigPath),
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    modelsRegistry: opts.modelsRegistry,
    memoryStore: opts.memoryStore,
    getConfig: () => opts.appConfig,
    onMaxContextResolved: opts.onModelContextResolved,
    persistPrefs,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const prefsCtx: PrefsHandlerContext = {
    meta: opts.agent.ctx.meta,
    snapshot: prefSnapshot,
    persist: persistPrefs,
    setYolo: opts.onYoloSwitch,
    setAutonomy: opts.onAutonomySwitch,
    pendingConfirms,
    configStore: opts.agent.container?.safeResolve?.(TOKENS.ConfigStore),
    send,
    broadcast,
  };

  // Project add/select are disabled in WebUI; `opts` remains shared because
  // projects.list and working_dir.set still read the live project root/config.
  const projectsCtx: EmbeddedProjectContext = {
    opts,
    abortControllers,
    abortLegacyRun: () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
      }
    },
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  const mailboxRoutes = createMailboxRouteHandlers({
    getProjectRoot: () =>
      opts.projectRoot ??
      (opts.agent.ctx as { projectRoot?: string | undefined }).projectRoot ??
      '',
    getGlobalRoot: () => (opts.globalConfigPath ? path.dirname(opts.globalConfigPath) : ''),
    events: opts.events,
  });

  // `opts` is passed by reference so the session handlers read live
  // agent.ctx.session / opts.sessionStore at call time.
  const sessionsCtx: EmbeddedSessionContext = {
    opts,
    buildSessionStart: (overrides) => buildSessionStartPayload(overrides),
    getCustomModeStore,
    send,
    broadcast,
    log: (m) => console.log(m),
  };

  // Connection-level cases (user_message/abort/ping/tool.confirm_result).
  // `opts` is by reference so `user_message` runs the live agent; the two
  // maps are the SAME instances the connection/close handlers mutate.
  const connectionCtx: EmbeddedConversationContext = {
    agent: opts.agent,
    abortControllers,
    pendingConfirms,
    send,
    broadcast,
    log: (m) => console.log(m),
  };
  // ── Message router ──────────────────────────────────────────────────
  // Canonical route-family dispatcher with CLI host capabilities.
  const kanbanHostRoutes = createCliKanbanHostRoutes({
    opts,
    send,
    broadcast,
    goalHandler,
    ...(kanbanSupervisor ? { kanbanSupervisor } : {}),
    ...(kanbanRunMirror ? { kanbanRunMirror } : {}),
  });
  let signalShutdown: (() => void) | undefined;
  const shutdown = (): void => signalShutdown?.();
  const handleMessage = createEmbeddedMessageRouter({
    trustBoundary,
    opts,
    logger: consoleLogger,
    send,
    sendResult,
    sessionPayload,
    currentSessionId,
    shutdown,
    providerCtx: wsHandlerCtx,
    brainCtx,
    introspectionCtx,
    skillsCtx,
    promptsCtx,
    designCtx,
    agentConfigCtx,
    prefsCtx,
    projectCtx: projectsCtx,
    mailboxRoutes,
    sessionCtx: sessionsCtx,
    conversationCtx: connectionCtx,
    goalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    kanbanHostRoutes,
    statusTracker: opts.statusTracker,
  });

  const terminalLogView = startBoundedTerminalLogView();
  const stopped = new Promise<void>((resolve) => {
    let listeningAnnounced = false;
    const announceListening = () => {
      if (listeningAnnounced) return;
      listeningAnnounced = true;
      console.log(`[WebUI] WebSocket server running on ws://${host}:${httpPort}`);
      try {
        setupEvents();
        opts.onListening?.({ httpPort, wsPort, host, url: accessUrl });
      } catch (err) {
        consoleLogger.error('setup_events_failed', { message: toErrorMessage(err) });
      }
    };
    wss.on('listening', announceListening);
    // SimpleUI deliberately binds the shared HTTP server before the rest of
    // the route contexts are assembled. In that path the WebSocketServer's
    // `listening` event may already have fired before this handler exists.
    if (httpServer?.server.listening || wss.address()) queueMicrotask(announceListening);

    // WebSocket connection handler — per-tab error handling, auth, client
    // registration, rate limiting, message dispatch, close cleanup, and the
    // initial session.start push. PR 14 of Issue #30: extracted to
    // `./webui-server/connection-handler.ts`.
    wss.on(
      'connection',
      createConnectionHandler({
        host,
        wsToken,
        requireToken,
        publicHostnames,
        publicWsUrl,
        clients,
        currentSessionId,
        goalHandler,
        specsHandler,
        sddBoardHandler,
        sddWizardHandler,
        worktreeHandler,
        terminalHandler,
        rateLimitMax,
        send,
        sessionPayload,
        handleMessage,
        abortControllers,
        pendingConfirms,
        buildSessionStartPayload,
        loadReplay: async () => {
          const activeSession = opts.agent.ctx.session ?? opts.session;
          await activeSession.flush().catch(() => undefined);
          if (opts.sessionStore) {
            const data = await opts.sessionStore.load(activeSession.id);
            // `events` feeds the audit markers; the load already parsed them.
            return { messages: data.messages, events: data.events, usage: data.usage };
          }
          const usage = opts.agent.ctx.tokenCounter.total();
          return { messages: opts.agent.ctx.messages, usage };
        },
        // Reads the on-disk transcripts when the in-memory ring is cold, which
        // it always is after a resume — the ring only holds what this process
        // watched happen.
        loadAgentSessions: async () => (await opts.agentTranscripts?.loadSessionsFromDisk()) ?? [],
        needsSetup: opts.needsSetup ?? false,
      }),
    );

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

    // Graceful shutdown (extracted to webui-server/lifecycle.ts, PR 7 of
    // #30). Idempotent: every runWebUI call registers its own SIGINT/SIGTERM
    // handlers, so a signal after this server already stopped (multiple
    // servers per process — tests, /webui restarts) must not re-run teardown
    // or fire a second unregister against a gone registry. The teardown
    // sequence (abort in-flight runs → unsubscribe events → close clients →
    // unregister → close HTTP/WS → resolve) lives in lifecycle.ts; the
    // run-loop state stays here and is threaded in as callbacks.
    signalShutdown = createWebuiShutdown({
      abortInFlight: () => {
        // Both the legacy single slot (project-switch path) and every
        // per-socket controller must be aborted — they are independent.
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        for (const c of abortControllers.values()) c.abort();
        abortControllers.clear();
      },
      unsubscribeEvents: () => {
        flushAllStreamBuffers();
        for (const unsub of eventUnsubscribers) unsub();
      },
      // Issue #322: kill session-owned children (MCP, bash/exec, tool-spawned
      // dev servers) before closing the listen socket so Windows process trees
      // do not outlive the parent and strand the event loop on open stdio.
      stopOwnedChildren: async () => {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          // force: true → SIGKILL / taskkill /T /F so cmd.exe shims cannot
          // orphan grandchildren (npx→node, vite, playwright MCP, …).
          getProcessRegistry().killAll({ force: true, includeProtected: true });
        } catch (err) {
          console.debug(
            `[webui-server] process-registry killAll failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (opts.mcpRegistry) {
          try {
            await opts.mcpRegistry.stopAll();
          } catch (err) {
            console.debug(
              `[webui-server] mcpRegistry.stopAll failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
      disposeResources: () => {
        credentialWatcherClose?.();
        credentialWatcherClose = undefined;
        goalHandler.dispose();
        sddBoardHandler.dispose();
        worktreeHandler.dispose();
        terminalHandler.dispose();
        kanbanRunMirror?.dispose();
        kanbanSupervisor?.dispose();
        void stopKanbanSupervisorMemoryStats?.();
        unregisterWebuiClient();
      },
      closeClients: () => {
        for (const [ws] of clients) ws.close();
        clients.clear();
      },
      closeHttpServer: () => {
        ipv6LoopbackServer?.close();
        httpServer?.server.close();
      },
      wss,
      pid: process.pid,
      registryBaseDir,
      onStopped: () => {
        terminalLogView.redraw();
        terminalLogView.stop();
        opts.onExit?.();
        resolve();
      },
    });

    registerWebuiSignalHandlers(signalShutdown);
  });

  function send(ws: WebSocket, msg: WSServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {
          // Client disconnected between the readyState check and the send
          // — let the 'close' handler remove it from the map naturally.
        }
      }
    }
  }

  // ---- Config I/O helpers (delegated to webui-server/provider-config) ----

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  return stopped.finally(() => terminalLogView.stop());
}
