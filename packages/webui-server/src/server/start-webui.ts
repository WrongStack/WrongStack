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
import { createSessionEventBridge, resolveSessionLoggingConfig } from '@wrongstack/core/storage';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID } from '@wrongstack/core/types';
import { expectDefined, startSharedHeapWatchdog, wstackGlobalRoot } from '@wrongstack/core/utils';
import { ensureSessionShell } from '@wrongstack/tools';
import {
  startFirstBootSageSync,
  TransformersEmbeddingProvider,
  VectorMemoryStore,
} from '@wrongstack/vector-memory';

import { createAgentServices } from './backend-services.js';
import { bootConfig, patchConfig } from './boot.js';
import { createConnectionHandler } from './connection-handler.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import { setupWebUiGovernance } from './governance-runtime.js';
import { createMessageDispatcher } from './message-dispatcher.js';
import { formatExternalAccessUrls } from './network-info.js';
import type { PendingConfirm } from './pending-confirms.js';
import { isStrictPort, listenWithRetry } from './port-utils.js';
import { createPreContextServices } from './pre-context-services.js';
import {
  type ConfigWriteLockHolder,
  type PrefHelperDeps,
  persistPrefsToConfig as persistPrefsToConfigImpl,
  prefSnapshot as prefSnapshotImpl,
  updateGlobalConfig as updateGlobalConfigImpl,
} from './pref-helpers.js';
import {
  ensureProjectDataDir,
  generateProjectSlug,
  loadManifest,
  saveManifest,
} from './projects-manifest.js';
import { bootstrapWrongProxyFromConfig } from './proxy-runtime.js';
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
import { scheduleOwnerlessEmptySessionCleanup } from './session-cleanup-scheduler.js';
import { collectDisplayedSessionIds, createSessionTransitionGate } from './session-handlers.js';
import { toSessionHistoryEntries } from './session-history.js';
import type { FileWatcherMetrics } from './setup-events.js';
import { setupCompanionServer } from './start-webui-companion.js';
import { setupWebuiCredentialWatcher } from './start-webui-credential-watcher.js';
import { setupWebuiProxyInstantApply } from './start-webui-proxy-apply.js';
import { createPackageOperationExecutor } from './start-webui-remediation.js';
import { setupWebuiShutdown } from './start-webui-shutdown.js';
import { createStandaloneTodosCheckpointLifecycle } from './start-webui-todos.js';
import type { WebUIOptions } from './types.js';
import { startWebUILiveStatusLogger } from './webui-status-logger.js';
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
    // Per-tab truth: a session that switched model/mode/context strategy
    // reports its OWN values, not the process-wide defaults.
    // `peek`: building a payload must not materialise an agent for a session
    // id that arrived from a stale browser tab.
    getSessionContext: (sessionId: string) => peekAgent?.(sessionId)?.ctx,
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

  let _runLockSession: string | null = null;
  const runLockControl = {
    get: (sessionId?: string): AbortController | null => {
      if (sessionId) return _sessionRunLocks.get(sessionId) ?? null;
      return _runLockSession ? (_sessionRunLocks.get(_runLockSession) ?? null) : null;
    },
    set: (ctrl: AbortController | null, sessionId?: string) => {
      const key = sessionId ?? _runLockSession;
      if (!key) return;
      if (ctrl) _sessionRunLocks.set(key, ctrl);
      else _sessionRunLocks.delete(key);
    },
    getSession: () => _runLockSession,
    setSession: (id: string | null) => {
      _runLockSession = id;
    },
    has: (sessionId: string) => _sessionRunLocks.has(sessionId),
    hasAny: () => _sessionRunLocks.size > 0,
    delete: (sessionId: string) => {
      _sessionRunLocks.delete(sessionId);
    },
    sessionIds: () => [..._sessionRunLocks.keys()],
  };

  /**
   * Cascade a session's stop into the subagents it spawned. Fire-and-forget:
   * the run is already aborted, and a fleet teardown failure must not turn
   * Stop into an error the user sees instead of a stopped run.
   */
  const stopSessionFleet = (sessionId: string): void => {
    if (!sessionId || !opts.stopSessionFleet) return;
    try {
      void Promise.resolve(opts.stopSessionFleet(sessionId)).catch((err) => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.stop_session_fleet_failed',
            sessionId,
            message: err instanceof Error ? err.message : String(err),
            timestamp: new Date().toISOString(),
          }),
        );
      });
    } catch {
      // A synchronous throw from the host hook is best-effort too.
    }
  };

  const pendingConfirms = new Map<string, PendingConfirm>();

  // One gate per host, shared by session transitions and run setup.
  const sessionTransitionGate = createSessionTransitionGate();

  // Audit-level-aware session log bridge — persists tool/error/provider
  // events to the session JSONL with the same contract as the CLI. The
  // getter form resolves the CURRENT writer on every append so events
  // follow session.new / session.resume swaps.
  const sessionLogging = resolveSessionLoggingConfig(config);
  const sessionBridge = createSessionEventBridge(
    () => context.session ?? session,
    sessionLogging.auditLevel,
    { sampling: sessionLogging.sampling },
  );

  /**
   * One audit bridge per session, bound to THAT session's writer.
   *
   * The single bridge above resolves "the current writer", so audit events for
   * a background tab had nowhere to go and were dropped — the tab worked, but
   * resuming it later showed a run with no tool history. Each tab's agent owns
   * its own writer, so the bridge is built from the agent registry and cached
   * per session; a session with no agent (never opened, already retired) has
   * no writer to address and yields undefined.
   */
  const sessionBridges = new Map<string, ReturnType<typeof createSessionEventBridge>>();
  const bridgeForSession = (sessionId: string) => {
    if (!sessionId) return undefined;
    const existing = sessionBridges.get(sessionId);
    if (existing) return existing;
    const agent = deps.getAgent?.(sessionId);
    const writer = agent?.ctx?.session;
    if (!writer) return undefined;
    const bridge = createSessionEventBridge(
      () => deps.getAgent?.(sessionId)?.ctx?.session,
      sessionLogging.auditLevel,
      { sampling: sessionLogging.sampling },
    );
    // Bounded: the tab ceiling is four, and a handful of retired sessions may
    // linger until the next miss.
    if (sessionBridges.size >= 16) sessionBridges.clear();
    sessionBridges.set(sessionId, bridge);
    return bridge;
  };

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
    abortRunLock: (sessionId?: string) => {
      if (sessionId) {
        // Strictly session-scoped. The previous fallback — "if this is the
        // most-recent run session, also abort the global controller" — is
        // what let opening a new tab kill a different tab's in-flight run.
        _sessionRunLocks.get(sessionId)?.abort();
        _sessionRunLocks.delete(sessionId);
        if (runLockControl.getSession() === sessionId) runLockControl.setSession(null);
        // Stopping a run means stopping the WORK, and this session's
        // subagents are part of that work. Aborting the leader's controller
        // only unwinds workers it is blocked on; async ones (spawn_subagent +
        // assign_task) keep going unless someone asks them to stop. Scoped to
        // this session so a tab's Stop never reaches another tab's fleet.
        stopSessionFleet(sessionId);
        return;
      }
      const running = [..._sessionRunLocks.keys()];
      for (const ctrl of _sessionRunLocks.values()) ctrl.abort();
      _sessionRunLocks.clear();
      runLockControl.setSession(null);
      for (const id of running) stopSessionFleet(id);
    },
    isRunActive: (sessionId?: string) =>
      sessionId ? _sessionRunLocks.has(sessionId) : runLockControl.hasAny(),
    getRunningSessionIds: () => [..._sessionRunLocks.keys()],
    withSessionTransition: sessionTransitionGate,
    getClients: () => clients,
  };

  const deps: WebuiDeps = {
    trustBoundary,
    agent,
    getAgent,
    ...(peekAgent ? { peekAgent } : {}),
    ...(isSessionLive ? { isSessionLive } : {}),
    // Real ownership check: a request may name the root session, any session
    // this runtime has an agent for, or any session a CONNECTED CLIENT
    // displays. The previous `() => true` accepted ANY non-empty string, so
    // garbage ids sailed through ensureCurrentSession and materialized
    // placeholder agents. `peekAgent` is non-creating; the displayed-clients
    // clause keeps legitimately-open-but-unresumed sessions servable (F5
    // reload before resume, or after the registry retired an idle agent) —
    // refusing those broke the client's session_not_ready auto-resume path.
    hasSession: (id: string) =>
      id === agent.ctx.session?.id ||
      Boolean(peekAgent?.(id)) ||
      [...clients.values()].some(
        (c) => c.sessionId === id || c.sessionIds?.has(id) === true,
      ),
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

  const stopLiveStatusLogger = startWebUILiveStatusLogger({
    events,
    getSessionList: () => {
      const activeIds = new Set<string>();
      for (const client of clients.values()) {
        if (client.sessionId) activeIds.add(client.sessionId);
        for (const id of client.sessionIds ?? []) activeIds.add(id);
      }
      const currentId = state.getSession().id;
      if (activeIds.size === 0 && currentId) {
        activeIds.add(currentId);
      }
      return Array.from(activeIds).map((id) => {
        const ag = deps.peekAgent?.(id) ?? undefined;
        const cfg = state.getConfig();
        const isRunning = state.isRunActive(id);
        return {
          id,
          model: ag?.ctx?.model ?? cfg.model,
          provider: ag?.ctx?.provider?.id ?? cfg.provider,
          isRunning,
        };
      });
    },
    // Read-only: a status line must not create the agent it is describing.
    getAgent: (sessionId) => deps.peekAgent?.(sessionId),
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
    stopLiveStatusLogger,
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
    globalConfigPath,
  });
}
