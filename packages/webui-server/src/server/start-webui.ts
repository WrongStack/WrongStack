/**
 * Standalone WebUI server entry point.
 *
 * Phase 1d of the god-module split: `startWebUI` moved here from
 * `./index.ts` so that `index.ts` is a pure re-export barrel.
 * This module owns the full server lifecycle: port resolution, boot,
 * service construction (Phase 1c), route/dispatcher/connection wiring
 * (Phase 1b/1a), WS + HTTP server creation, and graceful shutdown.
 */
import type { Config } from '@wrongstack/contracts/types';
import { ensureSessionShell } from '@wrongstack/tools';
import { patchConfig } from './boot.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import type { PendingConfirm } from './pending-confirms.js';
import {
  persistPrefsToConfig as persistPrefsToConfigImpl,
  prefSnapshot as prefSnapshotImpl,
} from './pref-helpers.js';
import type { WebuiCallbacks, WebuiDeps, WebuiMutableState } from './routes.js';
import { armEvents, createWsServers, resolvePorts, startHttpServer } from './server-runtime.js';
import { collectDisplayedSessionIds, createSessionTransitionGate } from './session-handlers.js';
import { createDefaultFileWatcherMetrics, type FileWatcherMetrics } from './setup-events.js';
import { projectModelRuntimePrefs } from './standalone-pipelines.js';
import { createStandaloneAgentServices } from './start-webui-agent-services.js';
import { bindSharedHttpServer } from './start-webui-bind.js';
import { setupCompanionServer } from './start-webui-companion.js';
import { prepareWebuiConfig } from './start-webui-config.js';
import { createWebuiCallbacks } from './start-webui-deps.js';
import { createStartWebuiSessionPayloadHelper } from './start-webui-payload.js';
import { createWebuiPreContextPhase } from './start-webui-pre-context.js';
import { createPackageOperationExecutor } from './start-webui-remediation.js';
import {
  createRunLockControl,
  createSessionBridgeManager,
  stopSessionFleet,
} from './start-webui-session-runtime.js';
import { createWebuiMutableState } from './start-webui-state.js';
import { createStandaloneTodosCheckpointLifecycle } from './start-webui-todos.js';
import { buildStandaloneWebuiDeps, wireStandaloneWebuiRuntime } from './start-webui-wiring.js';
import type { WebUIOptions } from './types.js';
import { broadcast, resolveAuthToken } from './ws-utils.js';

export { createStandaloneTodosCheckpointLifecycle };

export async function startWebUI(
  opts: WebUIOptions & {
    wsHost?: string | undefined;
    httpPort?: number | undefined;
    accessToken?: string | undefined;
    publicUrl?: string | undefined;
    publicWsUrl?: string | undefined;
    requireToken?: boolean | undefined;
    open?: boolean | undefined;
  } = {},
): Promise<void> {
  // Pin one stable shell for the session on Windows (PowerShell by default) via
  // WRONGSTACK_SHELL before the system-prompt builder is constructed below, so
  // the model is told exactly which shell + syntax to use. No-op on POSIX / when
  // the user already set WRONGSTACK_SHELL.
  ensureSessionShell();

  const ports = await resolvePorts(opts);
  // `let`: the bind below may advance past an EADDRINUSE (findFreePort's
  // TOCTOU window) and every downstream consumer must see the bound port.
  const { wsHost, publicUrl, publicWsUrl, requireToken } = ports;
  let httpPort = ports.httpPort;

  console.log('[WebUI] Starting backend services...');

  const prepared = await prepareWebuiConfig(opts);
  const { boot, vault, configWriteLock, profileConfigPath, prefHelperDeps, updateGlobalConfig } =
    prepared;
  const { globalConfigPath, wpaths, logger } = boot;
  const needsProvider = prepared.needsProvider;
  let config = prepared.config;

  /** Mutable project root. File handlers,
   *  sessionStartPayload, and session store use this value. */
  let projectRoot = boot.projectRoot;
  /** Mutable working directory — starts at projectRoot, changeable via
   *  `working_dir.set` WS message. Must always stay inside projectRoot. */
  let workingDir = projectRoot;

  const preContextPhase = await createWebuiPreContextPhase({
    config,
    wpaths,
    logger,
    opts,
    vault,
    globalConfigPath,
    projectRoot,
    workingDir,
    needsProvider,
  });
  const { preContext, vectorMemoryStore, vectorMemoryModelCacheDir, memoryStore, todosCheckpoint } =
    preContextPhase;
  const { disposeVectorMirror } = preContextPhase;
  const { modelsRegistry, events, modelCapabilitiesRef, context, sessionIdentity } = preContext;
  let sessionStore = preContext.sessionStore;
  let session = preContext.session;
  let sessionStartedAt = preContext.sessionStartedAt;
  let modeId = preContext.modeId;
  const needsSetup = preContext.needsSetup;

  // Pref keys + snapshot + persistence live in ./pref-helpers.ts (Phase 1c).
  // Thin closures below keep the original signatures the route layer expects
  // while threading the live configWriteLock holder.
  const prefSnapshot = (): Record<string, unknown> => prefSnapshotImpl(context.meta);
  const persistPrefsToConfig = async (payload: Record<string, unknown>): Promise<void> => {
    await persistPrefsToConfigImpl(prefHelperDeps, configWriteLock, payload);
    // The request middleware reads the live config, not the file.
    const modelRuntime = projectModelRuntimePrefs(config.modelRuntime, payload);
    if (modelRuntime) {
      config = patchConfig(config, { modelRuntime: modelRuntime as Config['modelRuntime'] });
    }
  };

  // ── Post-context agent services (pipelines, compaction, agent, Brain,
  // per-feature WS handlers) — built in ./backend-services.ts (Phase 1c).
  // The factory returns everything startWebUI needs to wire routes + the
  // dispatcher; the updateAutoCompactionMaxContext closure captures the
  // live autoCompactor / modelCapabilitiesRef it built.
  // Per-session run locks. Up to MAX_CONCURRENT_SESSION_AGENTS sessions run
  // concurrently (one per WebUI tab), so this map — never a single global
  // controller — is the authority on what is running. Declared here, ahead of
  // `createAgentServices`, because the session-agent registry consults it
  // before evicting an agent.
  const _sessionRunLocks = new Map<string, AbortController>();
  /**
   * Late-bound view of "which sessions are on someone's screen".
   *
   * The connection map does not exist yet — it is built with the WebSocket
   * servers further down — but the session-agent registry is created inside
   * `createAgentServices` and needs the answer at eviction time, which is
   * always later than that.
   */
  let displayedSessionIds: (() => Set<string>) | undefined;

  const { trustBoundary, governanceHandle, otlpExport, agentServices } =
    await createStandaloneAgentServices({
      opts,
      config,
      getConfig: () => config,
      wpaths,
      logger,
      projectRoot,
      workingDir,
      preContext,
      memoryStore,
      getSession: () => session,
      getSessionStore: () => sessionStore,
      sessionRunLocks: _sessionRunLocks,
      isDisplayed: (sessionId: string) => displayedSessionIds?.().has(sessionId) ?? false,
      // Runs start only after the server listens, when `clients` exists.
      broadcastToClients: (message) => broadcast(clients, message),
      updateGlobalConfig,
    });
  const { peekAgent, toolExecutor, permissionPolicy, brain, updateAutoCompactionMaxContext } =
    agentServices;
  preContext.mcpRegistry.setTaskRecoveryContext?.(() => peekAgent?.(session.id)?.ctx ?? context);
  if (typeof context.meta['yolo'] === 'boolean') {
    permissionPolicy.setYolo?.(context.meta['yolo']);
  }

  // Helper: build the rich session.start payload from current runtime state.
  // Centralised so initial connect, post-/new, and post-model.switch all
  // broadcast the same shape — frontend treats this as the single source of
  // truth for everything in the status bar (model, context window, project).
  const sessionStartPayload = createStartWebuiSessionPayloadHelper({
    getConfig: () => config,
    getSessionId: () => session.id,
    getProjectRoot: () => projectRoot,
    getWorkingDir: () => workingDir,
    getModeId: () => modeId,
    getContextMeta: () => context.meta,
    needsSetup,
    stateGetter: () => state,
    modelsRegistry,
    peekAgent,
  });

  const watcherMetricsRef: FileWatcherMetrics = createDefaultFileWatcherMetrics();

  // Resolve the auth token once so the HTTP /ws-auth cookie and the WS
  // verifyClient share the SAME token. When opts.accessToken is undefined
  // (common) and no WEBUI_TOKEN env var is set, resolveAuthToken() generates
  // a fresh randomBytes token on EACH call — without this hoist the HTTP
  // server's cookie (tokenA) and the WS verifyClient (tokenB) would diverge,
  // locking browsers out of the WS upgrade when requireToken is active.
  const accessToken = resolveAuthToken(opts.accessToken);
  const httpServer = startHttpServer({
    getSessionProjectRoot: (sessionId) =>
      peekAgent?.(sessionId)?.ctx.projectRoot ??
      (session.id === sessionId ? context.projectRoot : undefined),
    wsHost,
    httpPort,
    wsToken: accessToken,
    publicWsUrl,
    publicUrl,
    requireToken,
    globalRoot: wpaths.globalRoot,
    globalConfigPath,
    projectRoot,
    openBrowser: !!opts.open,
    watcherMetrics: watcherMetricsRef,
    onFleetPing: () => {
      void eventArming.getFleetBroadcast()?.();
    },
    onTechStackEvent: (event) => broadcast(clients, event),
    // Read through `context` on every call rather than capturing: the running
    // loop swaps provider/model when the user switches (same live source the
    // completion handler reads).
    getLlm: () =>
      context.provider && context.model
        ? { provider: context.provider, model: context.model }
        : undefined,
    executePackageOperation: createPackageOperationExecutor({
      toolExecutor,
      context,
      events,
      permissionPolicy,
      brain,
    }),
    distDir: opts.distDir,
    // Vector memory store — mirrors the CLI host. When `vectorMemoryStore`
    // construction failed (read-only FS, etc.) we still pass the getter;
    // it just resolves to `undefined` and the API router answers 503.
    getVectorMemoryStore: () => vectorMemoryStore,
    vectorMemoryModelCacheDir,
    // The browser must not fetch HQ directly: HQ correctly rejects a foreign
    // Origin. Read the live metadata so a settings change is visible before
    // its asynchronous config write completes.
    getIntegrationTarget: (kind) => {
      const enabledKey = kind === 'hq' ? 'hqEnabled' : 'wrongProxyEnabled';
      const urlKey = kind === 'hq' ? 'hqUrl' : 'wrongProxyUrl';
      return context.meta[enabledKey] === true && typeof context.meta[urlKey] === 'string'
        ? (context.meta[urlKey] as string)
        : undefined;
    },
  });

  const wsResult = createWsServers(httpServer, ports, accessToken);
  const { wssPrimary, wssSecondary, clients } = wsResult;
  // Now the connection map exists, the registry can tell an open tab from a
  // closed one.
  displayedSessionIds = () =>
    new Set(collectDisplayedSessionIds({ getSession: () => session, clients }));

  // Subscribe to working directory changes from the CLI.
  context.onWorkingDirChanged((newDir) => {
    workingDir = newDir;
    broadcast(clients, { type: 'working_dir.changed', payload: { cwd: newDir, projectRoot } });
  });

  // Eternal-autonomy iteration broadcast.
  let eternalSubscription: { dispose: () => void } | null = null;
  if (opts.subscribeEternalIteration) {
    eternalSubscription = createEternalSubscription(
      opts.subscribeEternalIteration,
      broadcast,
      () => clients,
    );
  }

  /**
   * One run lock per conversation, and nothing that names a "current" one.
   *
   * The map used to be fronted by a `_runLockSession` pointer so that
   * zero-argument `get()`/`set()` could mean "the run" — a leftover from when
   * this server drove one session. With four tabs running at once that
   * pointer names whichever tab started a run last, which is nobody in
   * particular, so both accessors now require the session id and the pointer
   * is gone.
   */
  const runLockControl = createRunLockControl(_sessionRunLocks, (id, subagentIds) =>
    stopSessionFleet(id, opts.stopSessionFleet, subagentIds),
  );

  const pendingConfirms = new Map<string, PendingConfirm>();

  // One gate per host, shared by session transitions and run setup.
  const sessionTransitionGate = createSessionTransitionGate();

  const { sessionBridge, bridgeForSession } = createSessionBridgeManager(
    config as unknown as Record<string, unknown>,
    context,
    () => session,
    () => deps?.getAgent,
  );

  // Event arming + WS error handlers live in ./server-runtime.ts (Phase 1e).
  // The WS server's 'listening' event fires when the shared HTTP server
  // starts listening below.
  const eventArming = armEvents(
    wssPrimary,
    wssSecondary,
    wsHost,
    httpPort,
    {
      events,
      broadcast,
      clients,
      config,
      context,
      pendingConfirms,
      globalConfigPath,
      sessionBridge,
      bridgeForSession,
      ...(peekAgent ? { sessionContext: (id: string) => peekAgent(id)?.ctx } : {}),
      wpaths,
    },
    watcherMetricsRef,
  );

  httpPort = await bindSharedHttpServer({
    httpServer,
    wsHost: wsHost ?? '127.0.0.1',
    httpPort,
    requireToken,
    publicUrl,
  });

  const companionServer = await setupCompanionServer(httpServer, wsHost, httpPort);

  // ---- Route table (extracted to ./routes.ts in Phase 1a) ----
  const state: WebuiMutableState = createWebuiMutableState({
    getConfig: () => config,
    setConfig: (next) => {
      config = next;
    },
    getProjectRoot: () => projectRoot,
    setProjectRoot: (next) => {
      projectRoot = next;
    },
    getWorkingDir: () => workingDir,
    setWorkingDir: (next) => {
      workingDir = next;
    },
    getSession: () => session,
    setSession: (next) => {
      session = next;
    },
    getSessionStartedAt: () => sessionStartedAt,
    setSessionStartedAt: (next) => {
      sessionStartedAt = next;
    },
    getSessionStore: () => sessionStore,
    setSessionStore: (next) => {
      sessionStore = next;
    },
    getModeId: () => modeId,
    setModeId: (next) => {
      modeId = next;
    },
    modelCapabilitiesRef,
    configWriteLock,
    runLockControl,
    sessionRunLocks: _sessionRunLocks,
    sessionTransitionGate,
    clients,
  });

  const deps: WebuiDeps = buildStandaloneWebuiDeps({
    preContext,
    agentServices,
    trustBoundary,
    clients,
    vault,
    globalConfigPath,
    profileConfigPath,
    wpaths,
    pendingConfirms,
    logger,
    memoryStore,
    wsHost,
    requireToken,
    publicUrl,
    publicWsUrl,
    httpPort,
    wssPrimary,
    wssSecondary,
  });

  const cb: WebuiCallbacks = createWebuiCallbacks({
    sessionStartPayload,
    sessionIdentity,
    todosCheckpoint,
    deps,
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  });

  wireStandaloneWebuiRuntime({
    opts,
    state,
    deps,
    cb,
    preContext,
    agentServices,
    clients,
    pendingConfirms,
    runLockControl,
    profileConfigPath,
    vault,
    logger,
    wsHost,
    httpPort,
    accessToken,
    publicUrl,
    sessionStartPayload,
    otlpExport,
    httpServer,
    companionServer,
    wssPrimary,
    wssSecondary,
    todosCheckpoint,
    governanceHandle,
    eventArming,
    getEternalSubscription: () => eternalSubscription,
    clearEternalSubscription: () => {
      eternalSubscription = null;
    },
    memoryStore,
    vectorMemoryStore,
    getDisposeVectorMirror: () => disposeVectorMirror,
    globalConfigPath,
    configPaths: wpaths,
  });
}
