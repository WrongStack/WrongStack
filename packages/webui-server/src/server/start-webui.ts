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
import { getSharedProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import {
  createSessionEventBridge,
  resolveSessionLoggingConfig,
} from '@wrongstack/core/storage';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core/types';
import {
  expectDefined,
  startSharedHeapWatchdog,
  wstackGlobalRoot,
} from '@wrongstack/core/utils';
import { ensureSessionShell } from '@wrongstack/tools';
import {
  TransformersEmbeddingProvider,
  VectorMemoryStore,
  startFirstBootSageSync,
} from '@wrongstack/vector-memory';

import { createAgentServices } from './backend-services.js';
import { bootConfig, patchConfig } from './boot.js';
import { createConnectionHandler } from './connection-handler.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import { setupWebUiGovernance } from './governance-runtime.js';
import { createMessageDispatcher } from './message-dispatcher.js';
import { formatExternalAccessUrls } from './network-info.js';
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
  ensureProjectDataDir,
  generateProjectSlug,
  loadManifest,
  saveManifest,
} from './projects-manifest.js';
import {
  buildRoutes,
  type WebuiCallbacks,
  type WebuiDeps,
  type WebuiMutableState,
} from './routes.js';
import {
  armEvents,
  createSessionStartPayload,
  createWsServers,
  resolvePorts,
  startHttpServer,
} from './server-runtime.js';
import { isStrictPort, listenWithRetry } from './port-utils.js';
import { scheduleOwnerlessEmptySessionCleanup } from './session-cleanup-scheduler.js';
import { toSessionHistoryEntries } from './session-history.js';
import type { FileWatcherMetrics } from './setup-events.js';
import { setupCompanionServer } from './start-webui-companion.js';
import { setupWebuiCredentialWatcher } from './start-webui-credential-watcher.js';
import { createPackageOperationExecutor } from './start-webui-remediation.js';
import { setupWebuiShutdown } from './start-webui-shutdown.js';
import { createStandaloneTodosCheckpointLifecycle } from './start-webui-todos.js';
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
  const vectorMemoryModelCacheDir = path.join(
    projectRoot,
    '.wrongstack',
    'cache',
    'transformers-models',
  );
  try {
    vectorMemoryStore = new VectorMemoryStore({
      provider: new TransformersEmbeddingProvider({
        cacheDir: vectorMemoryModelCacheDir,
      }),
      projectRoot,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(
      `vector memory store disabled: ${message} — standalone WebUI will run on the SAGE-only surface.`,
    );
    vectorMemoryStore = undefined;
  }

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
    touchProject: (root, wd) => touchProjectEntry(root, wd),
  });
  const {
    modelsRegistry,
    container,
    configStore,
    providerRegistry,
    toolRegistry,
    memoryStore,
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
    void startFirstBootSageSync({
      store: vectorMemoryStore,
      memoryStore,
      logger,
    });
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
  const sessionStartPayload = createSessionStartPayload({
    getConfig: () => config,
    getSessionId: () => session.id,
    getProjectRoot: () => projectRoot,
    getWorkingDir: () => workingDir,
    getModeId: () => modeId,
    getContextMode: () =>
      String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
    getNeedsSetup: () => needsSetup,
    modelsRegistry,
  });

  const watcherMetricsRef: FileWatcherMetrics = {
    fileChangesDetected: 0,
    filesProcessed: 0,
    broadcastsSent: 0,
    debounceResets: 0,
    totalDebounceDelayMs: 0,
    activeProjects: 0,
    averageDebounceDelayMs: 0,
    watcherActive: false,
  };

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

  let _runLock: AbortController | null = null;
  let _runLockSession: string | null = null;
  const runLockControl = {
    get: () => _runLock,
    set: (ctrl: AbortController | null) => {
      _runLock = ctrl;
    },
    getSession: () => _runLockSession,
    setSession: (id: string | null) => {
      _runLockSession = id;
    },
  };

  const pendingConfirms = new Map<string, PendingConfirm>();

  // Audit-level-aware session log bridge — persists tool/error/provider
  // events to the session JSONL with the same contract as the CLI. The
  // getter form resolves the CURRENT writer on every append so events
  // follow session.new / session.resume swaps.
  const sessionLogging = resolveSessionLoggingConfig(
    config as never as Parameters<typeof resolveSessionLoggingConfig>[0],
  );
  const sessionBridge = createSessionEventBridge(
    () => context.session ?? session,
    sessionLogging.auditLevel,
    { sampling: sessionLogging.sampling },
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
      wpaths,
    },
    watcherMetricsRef,
  );

  // Start the shared HTTP+WebSocket server. The WS server is attached to this
  // HTTP server via {server: httpServer}, so a single listen() binds both the
  // HTTP frontend and the WS upgrade handler on the same port.
  // listenWithRetry closes the findFreePort TOCTOU window: the probe's
  // throwaway listener closed before this real bind, and a competitor may
  // have taken the port in that gap. Non-strict mode advances past
  // EADDRINUSE (bounded); strict mode (maxTries: 1) keeps the fail-fast
  // contract but rejects cleanly instead of crashing the process with an
  // unhandled 'error' event. Shared-port flake 2026-08-16.
  const strictPort = isStrictPort();
  const boundPort = await listenWithRetry(httpServer, wsHost, httpPort, {
    maxTries: strictPort ? 1 : 10,
  });
  if (boundPort !== httpPort) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'webui.port_reassigned',
        protocol: 'HTTP',
        requested: httpPort,
        assigned: boundPort,
        reason: 'bind-time EADDRINUSE retry',
        timestamp: new Date().toISOString(),
      }),
    );
    httpPort = boundPort;
  }
  {
    const authHint = requireToken
      ? ' (authentication required; configure WEBUI_TOKEN out of band)'
      : '';
    console.log(`[WebUI] HTTP server listening on http://${wsHost}:${httpPort}${authHint}`);
    const extraUrls = formatExternalAccessUrls({
      bindHost: wsHost,
      port: httpPort,
      publicUrl,
    });
    if (extraUrls.length > 0) {
      console.log('[WebUI] Protected endpoints on external interfaces:\n' + extraUrls.join('\n'));
    }
  }

  const companionServer = await setupCompanionServer(httpServer, wsHost, httpPort);

  // ── Project manifest helpers ──────────────────────────────────────────

  /**
   * Idempotent manifest registration (mirrors the CLI's
   * touchProjectInManifest): create the projects.json entry when missing,
   * refresh lastSeen/lastWorkingDir when present.
   */
  async function touchProjectEntry(root: string, workDir?: string): Promise<void> {
    const resolved = path.resolve(root);
    const manifest = await loadManifest(globalConfigPath);
    const now = new Date().toISOString();
    const existing = manifest.projects.find((p) => path.resolve(p.root) === resolved);
    if (existing) {
      existing.lastSeen = now;
      if (workDir) existing.lastWorkingDir = path.resolve(workDir);
    } else {
      manifest.projects.push({
        name: path.basename(resolved),
        root: resolved,
        slug: generateProjectSlug(resolved),
        createdAt: now,
        lastSeen: now,
        lastWorkingDir: workDir ? path.resolve(workDir) : undefined,
      });
    }
    await saveManifest(manifest, globalConfigPath);
    await ensureProjectDataDir(generateProjectSlug(resolved), globalConfigPath);
  }

  // ---- Route table (extracted to ./routes.ts in Phase 1a) ----
  const state: WebuiMutableState = {
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
    getModelCapabilities: () => modelCapabilitiesRef.current,
    getConfigWriteLock: () => configWriteLock.lock,
    setConfigWriteLock: (next) => {
      configWriteLock.lock = next;
    },
    abortRunLock: () => {
      const ctrl = runLockControl.get();
      if (ctrl) {
        ctrl.abort();
        runLockControl.set(null);
        runLockControl.setSession(null);
      }
    },
    isRunActive: () => runLockControl.get() !== null,
    getClients: () => clients,
  };

  const deps: WebuiDeps = {
    trustBoundary,
    agent,
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
    wsPort: httpPort,
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
  };

  const cb: WebuiCallbacks = {
    sessionStartPayload,
    claimSession: (sessionId, target) => sessionIdentity.claim(sessionId, target),
    onBeforeSessionTodosReplaced: todosCheckpoint.rebind,
    onSessionSwapped: async (sessionId, target) => {
      await sessionIdentity.activate(sessionId, target);
      const { hydrateSessionKanban } = await import('@wrongstack/tools/session-kanban');
      await hydrateSessionKanban(deps.context);
    },
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  };

  const credentialWatcherClose = setupWebuiCredentialWatcher({
    watchConfigPath: profileConfigPath,
    vault,
    logger,
    state,
    deps,
    clients,
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
      runActive: runLockControl.get() !== null,
    }),
  });

  const routes = buildRoutes(state, deps, cb);
  const stopEmptySessionCleanup = scheduleOwnerlessEmptySessionCleanup({
    getSessionStore: state.getSessionStore,
    getActiveSessionId: () => state.getSession().id,
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

  const mailbox = getSharedProjectMailbox(
    resolveProjectDir(context.projectRoot, wstackGlobalRoot()),
    events,
  );
  const handleConnection = createConnectionHandler({
    getSessionId: () => session.id,
    sessionStartPayload,
    tokenCounter,
    context,
    loadReplay: async () => {
      await session.flush().catch(() => undefined);
      const data = await sessionStore.load(session.id);
      return { messages: data.messages, events: data.events, usage: data.usage };
    },
    clients,
    pendingConfirms,
    onSecurityRejection: (ev) => {
      void mailbox
        .send({
          from: context.agentId,
          to: '*',
          type: 'note',
          audience: 'leaders',
          subject: `Security rejection: ${ev.issueCode}`,
          body:
            `Decoder tripwire ${ev.issueCode}: ${ev.issueMessage}\n\n` +
            `connectionId: ${ev.connectionId ?? '?'}\n` +
            `sessionId: ${ev.sessionId ?? '?'}\n` +
            `agentId: ${ev.agentId ?? '?'}\n` +
            `projectRoot: ${ev.projectRoot ?? '?'}`,
          priority: 'high',
          senderSessionId: session.id,
        })
        .catch((err: unknown) => {
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'webui.security_rejection_mailbox_note_failed',
              message: String(err),
              timestamp: new Date().toISOString(),
            }),
          );
        });
    },
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
    getCredentialWatcherClose: () => credentialWatcherClose,
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
    globalConfigPath,
  });
}
