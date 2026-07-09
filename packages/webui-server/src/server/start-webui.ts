/**
 * Standalone WebUI server entry point.
 *
 * Phase 1d of the god-module split: `startWebUI` moved here from
 * `./index.ts` so that `index.ts` is a pure re-export barrel.
 * This module owns the full server lifecycle: port resolution, boot,
 * service construction (Phase 1c), route/dispatcher/connection wiring
 * (Phase 1b/1a), WS + HTTP server creation, and graceful shutdown.
 */
import {
  resolvePorts,
  createSessionStartPayload,
  createWsServers,
  armEvents,
  startHttpServer,
  registerShutdown,
} from './server-runtime.js';
import { createPreContextServices } from './pre-context-services.js';
import * as path from 'node:path';
import {
  createDefaultPipelines,
  createSessionEventBridge,
  DEFAULT_CONTEXT_WINDOW_MODE_ID,
  expectDefined,
  type ProviderConfig,
  resolveSessionLoggingConfig,
  watchProviderConfig,
} from '@wrongstack/core';
import { toErrorMessage } from '@wrongstack/core/utils';
import { makeProviderFromConfig } from '@wrongstack/providers';
import {
  ensureSessionShell,
} from '@wrongstack/tools';
import { bootConfig, patchConfig } from './boot.js';
import { createAgentServices } from './backend-services.js';
import { createConnectionHandler } from './connection-handler.js';
import { createMessageDispatcher } from './message-dispatcher.js';
import type { PendingConfirm } from './pending-confirms.js';
import {
  persistPrefsToConfig as persistPrefsToConfigImpl,
  prefSnapshot as prefSnapshotImpl,
  updateGlobalConfig as updateGlobalConfigImpl,
  type PrefHelperDeps,
  type ConfigWriteLockHolder,
} from './pref-helpers.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import { unregisterInstance } from './instance-registry.js';
import {
  ensureProjectDataDir,
  generateProjectSlug,
  loadManifest,
  saveManifest,
} from './projects-manifest.js';
import { projectSavedProviders } from './provider-handlers.js';
import {
  buildRoutes,
  type WebuiCallbacks,
  type WebuiDeps,
  type WebuiMutableState,
} from './routes.js';
import type { FileWatcherMetrics } from './setup-events.js';
import {
  broadcast,
} from './ws-utils.js';
import type { WebUIOptions } from './types.js';

export async function startWebUI(
  opts: WebUIOptions & {
    wsPort?: number | undefined;
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
  const { wsHost, wsPort, httpPort, publicUrl, publicWsUrl, requireToken } = ports;

  console.log('[WebUI] Starting backend services...');

  // Boot configuration
  const boot = await bootConfig();
  const { config: baseConfig, globalConfigPath, wpaths, logger } = boot;
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

  // Serialize concurrent config writes to prevent races between model.switch
  // and key.add/key.update handlers that both read-modify-write globalConfigPath.
  // Held in a mutable object so the pref-helpers (./pref-helpers.ts, Phase 1c)
  // can update the lock in place — TypeScript flattens Promise<Promise<void>>,
  // so we can't return the new lock from an async helper.
  const configWriteLock: ConfigWriteLockHolder = { lock: Promise.resolve() };

  // Unified global config mutation: read → decrypt → mutate → encrypt → write,
  // serialized behind configWriteLock. Implementation lives in
  // ./pref-helpers.ts; this thin wrapper preserves the two-arg signature the
  // route layer (provider routes, key handlers) expects.
  const prefHelperDeps: PrefHelperDeps = { globalConfigPath, vault, logger };
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
    config = patchConfig(config, { provider: firstKey });
    console.log('[WebUI] No active provider — auto-selected:', firstKey);
  }

  // If still no provider, the frontend will show a setup screen.
  // We still start the HTTP/WS servers so the user can configure via the UI.
  const needsProvider = !config.provider || !config.model;

  // ── Pre-context services (registries, stores, session, system prompt,
  // provider, context) — built in ./pre-context-services.ts (Phase 1f).
  // The factory returns all services + the initial values of the mutable
  // bindings the route layer swaps at runtime (session, sessionStore,
  // sessionStartedAt, modeId). Those stay as `let` here so state setters
  // can update them.
  const preContext = await createPreContextServices({
    config, wpaths, logger, opts, vault, globalConfigPath,
    projectRoot, workingDir, needsProvider,
    touchProject: (root, wd) => touchProjectEntry(root, wd),
  });
  const {
    modelsRegistry, container, configStore, providerRegistry, toolRegistry,
    memoryStore, events, mcpRegistry, sessionReader,
    annotationsStore, tokenCounter, modeStore, customModeStore,
    skillLoader, skillInstaller, promptsCtx, modelCapabilitiesRef,
    provider, context,
  } = preContext;
  let sessionStore = preContext.sessionStore;
  let session = preContext.session;
  let sessionStartedAt = preContext.sessionStartedAt;
  let modeId = preContext.modeId;
  const needsSetup = preContext.needsSetup;

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
  const agentServices = await createAgentServices({
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
    modelCapabilitiesRef,
    sessionGetter: () => session,
    sessionReader,
    annotationsStore,
  });
  const {
    compactor,
    autoCompactor,
    agent,
    permissionPolicy,
    pipelines,
    brain,
    brainSettings,
    brainLog,
    brainMonitor,
    codebaseIndexing,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    collabHandler,
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
    getContextMode: () => String(context.meta['contextWindowMode'] ?? DEFAULT_CONTEXT_WINDOW_MODE_ID),
    getNeedsSetup: () => needsSetup,
    modelsRegistry,
  });

  // WebSocket server(s).
  //
  // When the user keeps the default loopback bind (127.0.0.1), we ALSO open a
  // second listener on ::1 (IPv6 loopback). Reason: Chrome/Edge on Windows
  // resolve `localhost` to `[::1]` before `127.0.0.1`, so a single v4-only
  // bind causes "ws disconnect hep" — clients hammer the v6 socket, get
  // ECONNREFUSED, fall back to v4 inconsistently. Listening on both v4 and v6
  // loopback keeps the connection scope "this machine only" while removing
  // the resolution-order coin flip.
  //
  // When the user explicitly sets WS_HOST (e.g. 0.0.0.0 or a LAN IP), we
  // respect that choice exactly and don't add a second listener.
  const wsResult = createWsServers(ports, opts.accessToken);
  const { wssPrimary, wssSecondary, wsToken, clients } = wsResult;

  // Subscribe to working directory changes from the CLI.
  context.onWorkingDirChanged((newDir) => {
    workingDir = newDir;
    broadcast(clients, { type: 'working_dir.changed', payload: { cwd: newDir, projectRoot } });
  });

  // Eternal-autonomy iteration broadcast.
  let eternalSubscription: { dispose: () => void } | null = null;
  if (opts.subscribeEternalIteration) {
    eternalSubscription = createEternalSubscription(opts.subscribeEternalIteration, broadcast, () => clients);
  }

  let _runLock: AbortController | null = null;
  const runLockControl = { get: () => _runLock, set: (ctrl: AbortController | null) => { _runLock = ctrl; } };

  const pendingConfirms = new Map<string, PendingConfirm>();

  // Audit-level-aware session log bridge — persists tool/error/provider
  // events to the session JSONL with the same contract as the CLI. The
  // getter form resolves the CURRENT writer on every append so events
  // follow session.new / session.resume swaps.
  const sessionLogging = resolveSessionLoggingConfig(config as never as Parameters<typeof resolveSessionLoggingConfig>[0]);
  const sessionBridge = createSessionEventBridge(() => context.session ?? session, sessionLogging.auditLevel, { sampling: sessionLogging.sampling });

  // watcherMetrics — shared by setupEvents (via armEvents) and the HTTP
  // /debug/watcher-metrics endpoint. Defined early so armEvents can read it.
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

  // Event arming + WS error handlers live in ./server-runtime.ts (Phase 1e).
  const eventArming = armEvents(wssPrimary, wssSecondary, wsHost, wsPort, {
    events, broadcast, clients, config, context, pendingConfirms, globalConfigPath, sessionBridge, wpaths,
  }, watcherMetricsRef);

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
  // The 947-line inline construction block that used to live here
  // moved into buildRoutes() in ./routes.ts. We bind the local mutables
  // (`config`, `projectRoot`, `workingDir`, ...) into a `state` object so
  // routes observe live updates (config switch, project swap, mode
  // change), pass the static services as `deps`, and forward the
  // handful of boot-local closures (config persistence, pref snapshot,
  // …) as `cb`.
  //
  // The 13 destructured names (`providerRoutes`, `sessionRoutes`, …)
  // are then referenced by `handleMessage` exactly the way the inline
  // `let *Routes` block was — no surface change.

  // Mutable bindings — wrapped by `state` for buildRoutes().
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
      }
    },
    getClients: () => clients,
  };

  const deps: WebuiDeps = {
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
    wsPort,
    httpPort,
    wssPrimary,
    wssSecondary,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    collabHandler,
    terminalHandler,
    brain,
    brainSettings,
    brainLog,
  };

  const cb: WebuiCallbacks = {
    sessionStartPayload,
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  };

  // Hot-reload provider credentials when config.json changes on disk (another
  // terminal's `wstack auth`, a provider panel in another window, or a manual
  // edit). Rebuild the live agent's provider so the next message uses the new
  // key without restarting the server, and re-broadcast the saved-providers
  // projection so every connected panel re-renders. Mirrors `switchModel`'s
  // live-swap (routes.ts). Escape hatch: WRONGSTACK_DISABLE_CONFIG_WATCH=1.
  let credentialWatcherClose: (() => void) | undefined;
  if (process.env['WRONGSTACK_DISABLE_CONFIG_WATCH'] !== '1') {
    let lastActiveCfg = JSON.stringify(
      state.getConfig().providers?.[deps.context.provider.id] ?? null,
    );
    // Track the shared display language so a cross-process change (e.g. the
    // desktop shell writing config.uiLocale) propagates to every connected
    // webui client live, without a restart.
    let lastUiLocale: string | undefined = state.getConfig().uiLocale;
    const credentialWatcher = watchProviderConfig(
      globalConfigPath,
      vault,
      (snapshot) => {
        // Refresh in-memory config + store so panels and the next switch read fresh.
        state.setConfig(
          patchConfig(state.getConfig(), {
            providers: snapshot.providers,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          }),
        );
        deps.configStore.update({
          providers: snapshot.providers,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
        });
        broadcast(clients, {
          type: 'providers.saved',
          payload: { providers: projectSavedProviders(snapshot.providers) },
        });

        // Display language live-propagation: when config.uiLocale changes in
        // another process, seed context.meta + broadcast prefs.updated so every
        // connected client re-renders in the new language (handlePrefsUpdated →
        // useLocalPrefs → i18n.changeLanguage).
        const newUi = snapshot.uiLocale;
        if (newUi !== lastUiLocale) {
          lastUiLocale = newUi;
          if (newUi) {
            deps.context.meta['uiLocale'] = newUi;
            broadcast(clients, { type: 'prefs.updated', payload: { uiLocale: newUi } });
          }
        }

        const activeId = deps.context.provider.id;
        const newCfgStr = JSON.stringify(snapshot.providers[activeId] ?? null);
        if (newCfgStr === lastActiveCfg) return; // active provider creds unchanged
        lastActiveCfg = newCfgStr;
        try {
          const providerCfg: ProviderConfig = snapshot.providers[activeId] ?? {
            type: activeId,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
          };
          const newProv = deps.providerRegistry.has(activeId)
            ? deps.providerRegistry.create({ ...providerCfg, type: activeId } as never)
            : makeProviderFromConfig(activeId, { ...providerCfg, type: activeId });
          deps.context.provider = newProv;
          void updateAutoCompactionMaxContext(newProv).catch(() => undefined);
          console.log(`[WebUI] Provider credentials reloaded from config.json (${activeId})`);
        } catch (err) {
          console.warn(
            `[WebUI] Credential hot-reload failed for ${activeId}: ${toErrorMessage(err)}`,
          );
        }
      },
      { warn: (m) => logger.warn(`Config watcher: ${m}`) },
    );
    credentialWatcherClose = credentialWatcher.close;
  }

  // Build the route table (Phase 1a) + the message dispatcher and connection
  // handler (Phase 1b). The dispatcher owns the inbound `switch (msg.type)`
  // and the runLock guard; the connection handler owns rate-limiting, F5
  // transcript replay, and per-client lifecycle. Both live in their own
  // modules so `startWebUI` reads as orchestration.
  const routes = buildRoutes(state, deps, cb);
  const handleMessage = createMessageDispatcher({
    state,
    deps,
    cb,
    routes,
    promptsCtx,
    codebaseIndexing,
    runLock: runLockControl,
    pendingConfirms,
  });
  const handleConnection = createConnectionHandler({
    getSessionId: () => session.id,
    sessionStartPayload,
    tokenCounter,
    context,
    loadReplay: async () => {
      await session.flush().catch(() => undefined);
      const data = await sessionStore.load(session.id);
      return { messages: data.messages, usage: data.usage };
    },
    clients,
    pendingConfirms,
    autoPhaseHandler,
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
  // HTTP server for the React frontend (port 3456) — see `http-server.ts`
  // for the static-serve, MIME matching, path-traversal guard, and CSP
  // header logic. Constructed here, listen()d below alongside the WS server.
  // `globalRoot` powers the /api/sessions and /api/sessions/:id/agents
  // handlers (read the cross-process SessionRegistry); `apiToken` is the
  // shared auth token the HTTP API requires when bound to a non-loopback
  // host (LAN exposure). Loopback binds skip the token check, mirroring
  // the WS verifyClient loopback-bootstrap policy.

  const httpServer = startHttpServer({
    wsHost, httpPort, wsPort, wsToken, publicWsUrl, publicUrl, requireToken,
    globalRoot: wpaths.globalRoot, globalConfigPath, projectRoot,
    openBrowser: !!opts.open, watcherMetrics: watcherMetricsRef,
    onFleetPing: () => { void eventArming.getFleetBroadcast()?.(); },
    distDir: opts.distDir,
  });

  registerShutdown({
    flushSession: async () => {
      await session.append({ type: 'session_end', ts: new Date().toISOString(), usage: tokenCounter.total() });
      await session.close();
    },
    clients: () => clients.keys(),
    servers: [httpServer, wssPrimary, ...(wssSecondary ? [wssSecondary] : [])],
    onShutdown: () => {
      credentialWatcherClose?.();
      brainMonitor.stop();
      void mcpRegistry.stopAll().catch(() => undefined);
      eventArming.getDispose()?.();
      if (eternalSubscription) { eternalSubscription.dispose(); eternalSubscription = null; }
      codebaseIndexing.dispose();
      return unregisterInstance(process.pid, path.dirname(globalConfigPath));
    },
  });
}

/**
 * Webui-side mailbox bridge discovery.
 *
 * The webui doesn't spawn a bridge — the bridge (`wstack mailbox serve`)
 * is spawned by any CLI surface via the auto-bootstrap wiring. We just
 * probe the per-project lock for an already-running instance and stash
 * the discovered handle on `ctx.meta['mailboxBridge']` so any later
 * code (the `/mailbox` HTTP surface, agent-status broadcasters,
 * external-agent proxy) can find it without re-running discovery.
 *
 * If no bridge is running, we log a breadcrumb so the user knows
 * to start one (`wstack --repl`, `wstack --webui`, or
 * `wstack mailbox serve` standalone).
 *
 * Best-effort: never throws. A failure (missing lock dir, ENOENT,
 * etc.) logs at warn level and returns — the webui keeps running.
 */
// discoverMailboxBridgeForWebui extracted → ./discover-mailbox-bridge.ts
