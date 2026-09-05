/**
 * Standalone WebUI server entry point.
 *
 * Phase 1d of the god-module split: `startWebUI` moved here from
 * `./index.ts` so that `index.ts` is a pure re-export barrel.
 * This module owns the full server lifecycle: port resolution, boot,
 * service construction (Phase 1c), route/dispatcher/connection wiring
 * (Phase 1b/1a), WS + HTTP server creation, and graceful shutdown.
 */

import * as path from 'node:path';
import { createDefaultPipelines } from '@wrongstack/core/agent';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import { expectDefined, startSharedHeapWatchdog } from '@wrongstack/core/utils';
import { ensureSessionShell } from '@wrongstack/tools';
import type { VectorMemoryStore } from '@wrongstack/vector-memory';

import { createAgentServices } from './backend-services.js';
import { bootConfig, patchConfig } from './boot.js';
import { createConnectionHandler } from './connection-handler.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import { setupWebUiGovernance } from './governance-runtime.js';
import { createMessageDispatcher } from './message-dispatcher.js';
import type { PendingConfirm } from './pending-confirms.js';
import { createPreContextServices } from './pre-context-services.js';
import {
  type ConfigWriteLockHolder,
  type PrefHelperDeps,
  persistPrefsToConfig as persistPrefsToConfigImpl,
  prefSnapshot as prefSnapshotImpl,
  updateGlobalConfig as updateGlobalConfigImpl,
} from './pref-helpers.js';
import { bootstrapWrongProxyFromConfig } from './proxy-runtime.js';
import {
  buildRoutes,
  type WebuiCallbacks,
  type WebuiDeps,
  type WebuiMutableState,
} from './routes.js';
import { armEvents, createWsServers, resolvePorts, startHttpServer } from './server-runtime.js';
import { scheduleOwnerlessEmptySessionCleanup } from './session-cleanup-scheduler.js';
import { collectDisplayedSessionIds, createSessionTransitionGate } from './session-handlers.js';
import { toSessionHistoryEntries } from './session-history.js';
import { createDefaultFileWatcherMetrics, type FileWatcherMetrics } from './setup-events.js';
import { bindSharedHttpServer } from './start-webui-bind.js';
import { setupCompanionServer } from './start-webui-companion.js';
import { setupWebuiCredentialWatcher } from './start-webui-credential-watcher.js';
import { createWebuiCallbacks, createWebuiDeps } from './start-webui-deps.js';
import { setupWebuiTerminalLogging } from './start-webui-logging.js';
import { createStartWebuiSessionPayloadHelper } from './start-webui-payload.js';
import { touchProjectEntry } from './start-webui-project.js';
import { setupWebuiProxyInstantApply } from './start-webui-proxy-apply.js';
import { createPackageOperationExecutor } from './start-webui-remediation.js';
import { handleWebuiSecurityRejection } from './start-webui-security.js';
import {
  createRunLockControl,
  createSessionBridgeManager,
  stopSessionFleet,
} from './start-webui-session-runtime.js';
import { setupWebuiShutdown } from './start-webui-shutdown.js';
import { createWebuiMutableState } from './start-webui-state.js';
import { createStandaloneTodosCheckpointLifecycle } from './start-webui-todos.js';
import { initVectorMemoryStore, setupVectorMemoryMirror } from './start-webui-vector.js';
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

  // Boot configuration
  const boot = await bootConfig();
  const { config: baseConfig, globalConfigPath, wpaths, logger } = boot;
  // Seed the WrongProxy / WrongTrace singleton from the persisted
  // `tools.wrongProxy.{enabled,url}` block and await the first probe BEFORE
  // the server's provider is built (in `createPreContextServices` →
  // `resolveSetupProvider`). Without this, every provider-build path in this
  // process reads the core singleton at its default `{enabled:false, url:'',
  // active:false}` and constructs providers with the raw base URL — so a
  // separate WebUI process would ignore the proxy toggle entirely. The CLI
  // host already does this (cli-main.ts / system-prompt.ts); the standalone
  // server must too.
  await bootstrapWrongProxyFromConfig(baseConfig);
  // PR 5 of Phase 2: when the caller (typically the CLI) supplies a
  // pre-built `BackendServices`, prefer its `vault` over the one the
  // default boot would construct. This lets `runWebUI` keep owning the
  // vault lifecycle (so it can decrypt/encrypt its own config writes
  // in lockstep with the rest of the CLI session) instead of having
  // the webui build a parallel vault it can never see.
  const vault = opts.services?.vault ?? boot.vault;
  let config = baseConfig;

  /** Mutable project root. File handlers,
   *  sessionStartPayload, and session store use this value. */
  let projectRoot = boot.projectRoot;
  /** Mutable working directory — starts at projectRoot, changeable via
   *  `working_dir.set` WS message. Must always stay inside projectRoot. */
  let workingDir = projectRoot;

  // Serialize concurrent profile-config writes to prevent races between
  // model.switch and key.add/key.update handlers.
  // Held in a mutable object so the pref-helpers (./pref-helpers.ts, Phase 1c)
  // can update the lock in place — TypeScript flattens Promise<Promise<void>>,
  // so we can't return the new lock from an async helper.
  const configWriteLock: ConfigWriteLockHolder = { lock: Promise.resolve() };

  // Unified global config mutation: read → decrypt → mutate → encrypt → write,
  // serialized behind configWriteLock. Implementation lives in
  // ./pref-helpers.ts; this thin wrapper preserves the two-arg signature the
  // route layer (provider routes, key handlers) expects.
  // Resolve the active profile config path so updateGlobalConfig writes settings
  // to the canonical profile file (~/.wrongstack/profiles/<name>/config.json)
  // instead of the thin root bootstrap (~/.wrongstack/config.json).
  const activeProfile =
    (config as { activeProfile?: string | undefined }).activeProfile ?? 'default';
  const profileConfigPath = wpaths.profileConfig(activeProfile);
  const prefHelperDeps: PrefHelperDeps = { profileConfigPath, vault, logger };
  const updateGlobalConfig = async (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ): Promise<void> => updateGlobalConfigImpl(prefHelperDeps, configWriteLock, mutate, errorLabel);

  console.log('[WebUI] Config loaded:', config.provider ?? '(none)', '/', config.model ?? '(none)');

  // If no active provider is set but there are saved providers, pick the first one.
  // This handles configs written in older formats or by external tools.
  // Guard against config.providers being a string or other non-object value
  // (e.g., from a corrupted config or YAML parser misreading the value).
  if (
    !config.provider &&
    config.providers &&
    typeof config.providers === 'object' &&
    config.providers !== null &&
    !Array.isArray(config.providers) &&
    Object.keys(config.providers).length > 0
  ) {
    const firstKey = expectDefined(Object.keys(config.providers)[0]);
    // Also adopt a model when the provider carries a saved `models` allowlist.
    // Without this the auto-selected provider lands with a BLANK active model
    // (needsProvider stays true → chat opens with no model in the header).
    // A provider without a saved allowlist (e.g. a custom one to be probed)
    // still gets the provider; the model dropdown is populated on demand.
    const adoptModel = !config.model ? config.providers[firstKey]?.models?.[0] : undefined;
    config = patchConfig(config, {
      provider: firstKey,
      ...(adoptModel ? { model: adoptModel } : {}),
    });
    console.log(
      '[WebUI] No active provider — auto-selected:',
      firstKey,
      adoptModel ? `/ ${adoptModel}` : '',
    );
  }

  // If still no provider, the frontend will show a setup screen.
  // We still start the HTTP/WS servers so the user can configure via the UI.
  const needsProvider = !config.provider || !config.model;

  // Vector memory is an optional sibling to SAGE — embed locally via
  // @huggingface/transformers, persist to its own SQLite file. Mirrors the
  // production path in packages/cli/src/cli-main.ts so the standalone WebUI
  // host exposes the same surface as `wstack --webui`. The model cache lives
  // under `.wrongstack/cache/transformers-models` (outside the store's data
  // directory) so a future store-side cleanup never sweeps cached model
  // files. Constructor failures (read-only filesystem, unwritable project
  // root, corrupt SQLite parent) fall back to `undefined` so the standalone
  // WebUI still boots on the SAGE-only surface — the routes then report
  // `enabled: false` instead of failing to start.
  let vectorMemoryStore: VectorMemoryStore | undefined;
  /** Set once the live SAGE→vector mirror is subscribed; run at shutdown. */
  let disposeVectorMirror: (() => void) | undefined;
  const vectorMemoryModelCacheDir = path.join(
    projectRoot,
    '.wrongstack',
    'cache',
    'transformers-models',
  );
  vectorMemoryStore = initVectorMemoryStore({
    projectRoot,
    config: config as unknown as Record<string, unknown>,
    logger,
    vectorMemoryModelCacheDir,
  });

  // ── Pre-context services (registries, stores, session, system prompt,
  // provider, context) — built in ./pre-context-services.ts (Phase 1f).
  // The factory returns all services + the initial values of the mutable
  // bindings the route layer swaps at runtime (session, sessionStore,
  // sessionStartedAt, modeId). Those stay as `let` here so state setters
  // can update them.
  const preContext = await createPreContextServices({
    config,
    wpaths,
    logger,
    opts,
    vault,
    globalConfigPath,
    projectRoot,
    workingDir,
    needsProvider,
    touchProject: (root, wd) => touchProjectEntry(globalConfigPath, root, wd),
  });
  const {
    modelsRegistry,
    container,
    configStore,
    providerRegistry,
    toolRegistry,
    memoryStore: baseMemoryStore,
    events,
    mcpRegistry,
    sessionReader,
    annotationsStore,
    tokenCounter,
    modeStore,
    customModeStore,
    skillLoader,
    skillInstaller,
    promptsCtx,
    modelCapabilitiesRef,
    provider,
    context,
    sessionIdentity,
  } = preContext;
  // Reassigned below when the vector store comes up — see the vector-recall
  // wiring after the first-boot sync.
  let memoryStore = baseMemoryStore;
  let sessionStore = preContext.sessionStore;
  let session = preContext.session;
  const todosCheckpoint = createStandaloneTodosCheckpointLifecycle({
    state: context.state,
    sessionsDir: wpaths.projectSessions,
    sessionId: session.id,
    events,
    traceId: context.traceId,
    warn: (message) => logger.warn(message),
  });
  let sessionStartedAt = preContext.sessionStartedAt;
  let modeId = preContext.modeId;
  const needsSetup = preContext.needsSetup;

  // First boot per project: mirror the active SAGE corpus into the vector
  // store so semantic search starts warm instead of empty. Fire-and-forget
  // — the first run pays the ONNX model download, and boot must not block
  // on it. Skips instantly once the sage-sync marker says complete.
  // Mirrors the CLI host (cli-main.ts:133-139) so both surfaces expose
  // the same warm-start semantics. Safe to skip when the store
  // constructor failed (read-only FS, etc.) — the SAGE-only fallback
  // already covers that path.
  if (vectorMemoryStore) {
    const mirror = setupVectorMemoryMirror({
      vectorMemoryStore,
      baseMemoryStore: memoryStore,
      config: config as unknown as Record<string, unknown>,
      logger,
    });
    memoryStore = mirror.memoryStore;
    disposeVectorMirror = mirror.disposeVectorMirror;
  }

  // Pref keys + snapshot + persistence live in ./pref-helpers.ts (Phase 1c).
  // Thin closures below keep the original signatures the route layer expects
  // while threading the live configWriteLock holder.
  const prefSnapshot = (): Record<string, unknown> => prefSnapshotImpl(context.meta);
  const persistPrefsToConfig = async (payload: Record<string, unknown>): Promise<void> =>
    persistPrefsToConfigImpl(prefHelperDeps, configWriteLock, payload);

  // ── Post-context agent services (pipelines, compaction, agent, Brain,
  // per-feature WS handlers) — built in ./backend-services.ts (Phase 1c).
  // The factory returns everything startWebUI needs to wire routes + the
  // dispatcher; the updateAutoCompactionMaxContext closure captures the
  // live autoCompactor / modelCapabilitiesRef it built.
  const trustBoundary =
    opts.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'webui-trusted-host-compat-v1' });
  const governanceHandle =
    opts.installToolBoundary === undefined
      ? await setupWebUiGovernance({
          environment: process.env,
          projectRoot,
          projectId: wpaths.projectSlug,
          sessionId: session.id,
          contextMeta: context.meta,
          events,
          logger,
          captureWorkspaceCheckpoint: async () =>
            sessionStore.captureWorkspaceCheckpoint?.(session.id, 0),
        })
      : undefined;
  const installToolBoundary = opts.installToolBoundary ?? governanceHandle?.installToolBoundary;
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

  const agentServices = await createAgentServices({
    trustBoundary,
    config,
    wpaths,
    logger,
    projectRoot,
    workingDir,
    context,
    provider,
    container,
    toolRegistry,
    providerRegistry,
    modelsRegistry,
    events,
    mcpRegistry,
    memoryStore,
    modeStore,
    customModeStore,
    skillLoader,
    skillInstaller,
    tokenCounter,
    pipelines: createDefaultPipelines(),
    ...(installToolBoundary ? { installToolBoundary } : {}),
    modelCapabilitiesRef,
    sessionGetter: () => session,
    // Never evict a session agent that is mid-run (see the registry cap).
    isRunActive: (sessionId: string) => _sessionRunLocks.has(sessionId),
    // A tab still on screen outlives one that was closed, whatever order their
    // agents happened to be created in.
    isDisplayed: (sessionId: string) => displayedSessionIds?.().has(sessionId) ?? false,
    sessionReader,
    annotationsStore,
    // Brain settings persist to the GLOBAL config only (config.brain is on
    // the in-project deny list), serialized behind the shared write lock.
    persistBrainConfig: (brainConfig) =>
      updateGlobalConfig((decrypted) => {
        decrypted['brain'] = brainConfig;
      }, 'brain.config'),
  });
  const {
    compactor,
    autoCompactor,
    agent,
    getAgent,
    peekAgent,
    sessionAgentIds,
    isSessionLive,
    toolExecutor,
    permissionPolicy,
    pipelines,
    brain,
    brainSettings,
    brainRuntime,
    brainLog,
    brainMonitor,
    codebaseIndexing,
    goalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    collabHandler,
    disposeRealtimeHandlers,
    updateAutoCompactionMaxContext,
  } = agentServices;
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
    }),
    distDir: opts.distDir,
    // Vector memory store — mirrors the CLI host. When `vectorMemoryStore`
    // construction failed (read-only FS, etc.) we still pass the getter;
    // it just resolves to `undefined` and the API router answers 503.
    getVectorMemoryStore: () => vectorMemoryStore,
    vectorMemoryModelCacheDir,
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
  const runLockControl = createRunLockControl(_sessionRunLocks, (id) =>
    stopSessionFleet(id, opts.stopSessionFleet),
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

  const deps: WebuiDeps = createWebuiDeps({
    trustBoundary,
    agent,
    getAgent,
    peekAgent,
    sessionAgentIds,
    isSessionLive,
    clients,
    context,
    container,
    toolRegistry,
    modelsRegistry,
    providerRegistry,
    provider,
    mcpRegistry,
    vault,
    globalConfigPath,
    profileConfigPath,
    wpaths,
    configStore,
    tokenCounter,
    permissionPolicy,
    pendingConfirms,
    pipelines,
    logger,
    memoryStore,
    modeStore,
    skillLoader,
    skillInstaller,
    customModeStore,
    compactor,
    autoCompactor,
    events,
    wsHost,
    requireToken,
    publicUrl,
    publicWsUrl,
    httpPort,
    wssPrimary,
    wssSecondary,
    goalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    collabHandler,
    terminalHandler,
    brain,
    brainSettings,
    brainRuntime,
    brainLog,
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

  const credentialWatcherClose = setupWebuiCredentialWatcher({
    watchConfigPath: profileConfigPath,
    vault,
    logger,
    state,
    deps,
    clients,
    updateAutoCompactionMaxContext,
  });

  // WrongProxy instant-apply: rebuild the live provider when the proxy
  // toggle/URL changes (prefs handler → applyWrongProxyPrefs) or the
  // probe flips `active`, so Settings changes take effect immediately
  // in THIS process. Only wired in the standalone server — the CLI-hosted
  // path gets its own instance inside setupProviderRuntime (shared agent
  // context, exactly one rebuilder per process).
  const proxyInstantApplyDispose = setupWebuiProxyInstantApply({
    state,
    deps,
    updateAutoCompactionMaxContext,
  });

  // WebUI/SimpleUI joins the process flight recorder, including standalone servers.
  const stopHeapWatchdog = startSharedHeapWatchdog({
    collectStats: () => ({
      surface: opts.surface ?? 'webui',
      sessionId: context.session.id,
      messages: context.state.messages.length,
      messageEstimatedTokens: context.state.messages.reduce(
        (sum, message) => sum + (message._estTokens ?? 0),
        0,
      ),
      webClients: clients.size,
      pendingConfirms: pendingConfirms.size,
      runActive: runLockControl.hasAny(),
    }),
  });

  const { terminalDashboard, stopLiveStatusLogger } = setupWebuiTerminalLogging({
    wsHost: wsHost ?? '127.0.0.1',
    httpPort,
    accessToken,
    publicUrl,
    events,
    clients,
    state,
    deps,
  });

  const routes = buildRoutes(state, deps, cb);
  const stopEmptySessionCleanup = scheduleOwnerlessEmptySessionCleanup({
    getSessionStore: state.getSessionStore,
    getActiveSessionId: () => state.getSession().id,
    // Every tab the browser declared, not just the one in front — a
    // background tab's brand-new session is empty and would otherwise be
    // swept out from under it.
    getActiveSessionIds: () =>
      collectDisplayedSessionIds({ getSession: state.getSession, clients }),
    hasParticipants: (sessionId) => collabHandler.hasParticipants(sessionId),
    refreshSessions: async () => {
      const list = await state.getSessionStore().list(200);
      broadcast(clients, {
        type: 'sessions.list',
        payload: { sessions: toSessionHistoryEntries(list, state.getSession().id) },
      });
    },
    logger,
  });

  let kanbanSupervisorDispose: (() => void | Promise<void>) | null = null;
  const handleMessage = createMessageDispatcher({
    state,
    deps,
    routes,
    promptsCtx,
    codebaseIndexing,
    runLock: runLockControl,
    pendingConfirms,
    onDispose: (dispose) => {
      kanbanSupervisorDispose = dispose;
    },
  });

  const handleConnection = createConnectionHandler({
    getSessionId: () => session.id,
    sessionStartPayload,
    tokenCounter,
    context,
    loadReplay: async () => {
      await session.flush();
      const data = await sessionStore.load(session.id);
      return { messages: data.messages, events: data.events, usage: data.usage };
    },
    clients,
    pendingConfirms,
    onSecurityRejection: (ev) => handleWebuiSecurityRejection(context, events, session, ev),
    goalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    collabHandler,
    terminalHandler,
    handleMessage,
  });
  wssPrimary.on('connection', handleConnection);
  if (wssSecondary) wssSecondary.on('connection', handleConnection);

  setupWebuiShutdown({
    session,
    tokenCounter,
    clients,
    httpServer,
    companionServer,
    wssPrimary,
    wssSecondary,
    stopEmptySessionCleanup,
    getKanbanSupervisorDispose: () => kanbanSupervisorDispose,
    todosCheckpoint,
    stopHeapWatchdog,
    stopLiveStatusLogger,
    stopTerminalDashboard: () => terminalDashboard.stop(),
    getCredentialWatcherClose: () => credentialWatcherClose,
    getProxyInstantApplyDispose: () => proxyInstantApplyDispose,
    disposeRealtimeHandlers,
    governanceHandle,
    logger,
    brainMonitor,
    agentServices,
    mcpRegistry,
    sessionIdentity,
    eventArming,
    getEternalSubscription: () => eternalSubscription,
    clearEternalSubscription: () => {
      eternalSubscription = null;
    },
    codebaseIndexing,
    memoryStore,
    vectorMemoryStore,
    disposeVectorMirror: () => disposeVectorMirror?.(),
    flushSessionJournalsSync: agentServices.flushSessionJournalsSync,
    closeSessionJournals: agentServices.closeSessionJournals,
    globalConfigPath,
  });
}
