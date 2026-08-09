/**
 * Standalone WebUI server entry point.
 *
 * Phase 1d of the god-module split: `startWebUI` moved here from
 * `./index.ts` so that `index.ts` is a pure re-export barrel.
 * This module owns the full server lifecycle: port resolution, boot,
 * service construction (Phase 1c), route/dispatcher/connection wiring
 * (Phase 1b/1a), WS + HTTP server creation, and graceful shutdown.
 */

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as path from 'node:path';
import { createDefaultPipelines } from '@wrongstack/core/agent';
import { getSharedProjectMailbox, resolveProjectDir } from '@wrongstack/core/coordination';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import {
  attachTodosCheckpoint,
  createSessionEventBridge,
  resolveSessionLoggingConfig,
  watchProviderConfig,
} from '@wrongstack/core/storage';
import { DEFAULT_CONTEXT_WINDOW_MODE_ID, type ProviderConfig } from '@wrongstack/core/types';
import {
  expectDefined,
  sessionScopedPath,
  startSharedHeapWatchdog,
  toErrorMessage,
  wstackGlobalRoot,
} from '@wrongstack/core/utils';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { type PackageOperation, toLanguagePackageInput } from '@wrongstack/techstack';
import { ensureSessionShell } from '@wrongstack/tools';
import { createAgentServices } from './backend-services.js';
import { bootConfig, patchConfig } from './boot.js';
import { createConnectionHandler } from './connection-handler.js';
import { createEternalSubscription } from './eternal-iteration-broadcast.js';
import { setupWebUiGovernance } from './governance-runtime.js';
import { unregisterInstance } from './instance-registry.js';
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
import {
  armEvents,
  createSessionStartPayload,
  createWsServers,
  registerShutdown,
  resolvePorts,
  startHttpServer,
} from './server-runtime.js';
import type { FileWatcherMetrics } from './setup-events.js';
import type { WebUIOptions } from './types.js';
import { broadcast, resolveAuthToken } from './ws-utils.js';

export function createStandaloneTodosCheckpointLifecycle(input: {
  state: Parameters<typeof attachTodosCheckpoint>[0];
  sessionsDir: string;
  sessionId: string;
  events?: Parameters<typeof attachTodosCheckpoint>[3];
  traceId?: string | undefined;
  warn?: ((message: string) => void) | undefined;
}): {
  rebind: (sessionId: string, sessionsDir: string) => Promise<void>;
  detach: () => Promise<void>;
} {
  let checkpointSessionId = input.sessionId;
  let checkpointSessionsDir = input.sessionsDir;
  const attachCheckpoint = (sessionId: string, sessionsDir: string) =>
    attachTodosCheckpoint(
      input.state,
      sessionScopedPath(sessionsDir, sessionId, '.todos.json'),
      sessionId,
      input.events,
      input.traceId,
      input.warn,
    );
  let detachCurrent = attachCheckpoint(input.sessionId, input.sessionsDir);
  let checkpointAttached = true;
  const detachCurrentCheckpoint = async (): Promise<void> => {
    if (!checkpointAttached) return;
    checkpointAttached = false;
    await detachCurrent();
  };
  let transitionTail = Promise.resolve();

  const rebind = (nextSessionId: string, sessionsDir: string): Promise<void> => {
    const transition = transitionTail.then(async () => {
      if (
        checkpointAttached &&
        nextSessionId === checkpointSessionId &&
        sessionsDir === checkpointSessionsDir
      ) {
        return;
      }
      let detachFailed = false;
      let detachError: unknown;
      try {
        await detachCurrentCheckpoint();
      } catch (error) {
        // The listener unsubscribes before its final flush. The runtime has
        // already selected the next session, so bind that session even when
        // the old flush reports a failure; reattaching the old session would
        // persist future todos into the wrong sidecar.
        detachFailed = true;
        detachError = error;
      }
      const nextDetach = attachCheckpoint(nextSessionId, sessionsDir);
      checkpointSessionId = nextSessionId;
      checkpointSessionsDir = sessionsDir;
      detachCurrent = nextDetach;
      checkpointAttached = true;
      if (detachFailed) throw detachError;
    });
    transitionTail = transition.catch(() => undefined);
    return transition;
  };

  return {
    rebind,
    detach: async (): Promise<void> => {
      await transitionTail;
      await detachCurrentCheckpoint();
    },
  };
}

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
  const { wsHost, httpPort, publicUrl, publicWsUrl, requireToken } = ports;

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
    executePackageOperation: async (operation: PackageOperation, workspace?: string) => {
      const input = toLanguagePackageInput(operation, workspace);
      const use = {
        type: 'tool_use' as const,
        id: `techstack-remediation-${randomUUID()}`,
        name: 'language_package',
        input: { ...input },
      };
      const execute = async () => {
        const { outputs } = await toolExecutor.executeBatch([use], context, 'sequential');
        const output = outputs[0];
        if (!output) throw new Error('language_package returned no result');
        return output;
      };
      let output = await execute();
      if (output.result.type === 'tool_confirm_pending') {
        const pending = output.result;
        const confirmTool = output.tool;
        if (!confirmTool) throw new Error('Permission confirmation is missing its tool');
        if (events.listenerCount('tool.confirm_needed') === 0) {
          throw new Error('No permission confirmation surface is connected');
        }
        const decision = await new Promise<'yes' | 'no' | 'always' | 'deny'>((resolve) => {
          events.emit('tool.confirm_needed', {
            sessionId: context.session.id,
            tool: confirmTool,
            input: pending.input,
            toolUseId: pending.toolUseId,
            suggestedPattern: pending.suggestedPattern,
            decisionSource: pending.decisionSource,
            riskTier: pending.riskTier,
            boundaryReason: pending.boundaryReason,
            resolve,
          });
        });
        const rule = { tool: 'language_package', pattern: pending.suggestedPattern };
        if (decision === 'always') await permissionPolicy.trust(rule);
        else if (decision === 'yes') permissionPolicy.allowOnce(rule);
        else if (decision === 'deny') await permissionPolicy.deny(rule);
        else permissionPolicy.denyOnce(rule);
        if (decision === 'deny' || decision === 'no')
          throw new Error('Package operation was denied');
        output = await execute();
      }
      if (output.result.type === 'tool_confirm_pending') {
        throw new Error('Package operation still requires confirmation');
      }
      if (output.result.is_error) throw new Error(output.result.content);
      return { detail: output.result.content };
    },
    distDir: opts.distDir,
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
  httpServer.listen(httpPort, wsHost, () => {
    // The URL must carry the token.
    //
    // `requireAccessToken` is hard-`true` (http-server.ts) and
    // `resolveAuthToken` mints a fresh random token per process when
    // `WEBUI_TOKEN` is unset — so the banner's bare `http://host:port` was a
    // URL that always answered 401. The token was in scope right here (it is
    // handed to `formatExternalAccessUrls` two lines down) but that helper
    // returns `[]` for any non-wildcard bind, so on the DEFAULT loopback bind
    // the operator was never shown the token at all and had no way to open
    // the UI. `requestToken` already accepts `?token=` from a loopback peer;
    // it simply was never printed.
    const tokenQuery = accessToken ? `/?token=${encodeURIComponent(accessToken)}` : '';
    console.log(`[WebUI] HTTP server running on http://${wsHost}:${httpPort}${tokenQuery}`);
    // For wildcard binds, enumerate external network addresses so the
    // operator can see Tailscale/LAN URLs without manual lookup.
    const extraUrls = formatExternalAccessUrls({
      bindHost: wsHost,
      port: httpPort,
      token: accessToken,
      publicUrl,
    });
    if (extraUrls.length > 0) {
      console.log('[WebUI] Accessible on external interfaces:\n' + extraUrls.join('\n'));
    }
  });

  // Dual-stack / IPv6 companion listener.
  //
  // When the primary bind is IPv4-only, also try the IPv6 equivalent so
  // peers using IPv6 can connect. Tailscale assigns both v4 (100.x.x.x)
  // and v6 (fd7a:…) addresses; Chrome/Edge on Windows resolve `localhost`
  // to [::1] before 127.0.0.1. Without the companion listener, a v4-only
  // bind causes ECONNREFUSED for all IPv6 peers.
  //
  // When the primary bind is IPv6-only (::), try the IPv4 companion as a
  // fallback for systems where `::` does not accept IPv4-mapped
  // connections (net.ipv6.bindv6only=1, some Windows configs).
  //
  // Best-effort: on systems with dual-stack IPv6 sockets (bindv6only=0,
  // the Linux/macOS default), the companion listener may raise
  // EADDRINUSE because the primary's port is already covered. We
  // swallow EADDRINUSE along with EAFNOSUPPORT / EADDRNOTAVAIL (no IPv6
  // stack, IPv6 disabled, or companion already covered by dual-stack).
  const companion =
    wsHost === '127.0.0.1'
      ? '::1'
      : wsHost === '0.0.0.0' || wsHost === undefined
        ? '::'
        : wsHost === '::' || wsHost === '[::]'
          ? '0.0.0.0'
          : null;
  let companionServer: http.Server | null = null;
  if (companion) {
    const companionLabel = companion.includes(':') ? `[${companion}]` : companion;
    // A single http.Server cannot bind two addresses. Calling .listen() a
    // second time either throws ERR_SERVER_ALREADY_LISTEN (when the first
    // bind has completed) or silently overwrites the first (when both
    // calls run in the same synchronous tick — which is exactly this case).
    // Create a separate server that shares the request handler, and forward
    // 'upgrade' events so the WebSocketServer on the primary also serves WS
    // connections arriving on the companion address.
    companionServer = http.createServer();
    companionServer.on('request', (req, res) => httpServer.emit('request', req, res));
    companionServer.on('upgrade', (req, socket, head) =>
      httpServer.emit('upgrade', req, socket, head),
    );
    companionServer.on('error', (err: NodeJS.ErrnoException) => {
      // Throwing from an EventEmitter handler becomes an `uncaughtException`
      // and kills the process. This listener is explicitly best-effort — the
      // primary is already bound and serving by now — so an unexpected errno
      // must not take the whole WebUI down after the "server running" banner
      // has already printed. On Windows a socket held with
      // SO_EXCLUSIVEADDRUSE, or an AppContainer/firewall restriction, surfaces
      // as EACCES, which is not in the allow-list below. The WS secondary
      // handler (server-runtime.ts:337) already only logs.
      const expected =
        err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL' || err.code === 'EADDRINUSE';
      if (!expected) {
        console.warn(
          `[WebUI] companion listener on ${companionLabel} failed (${err.code ?? 'unknown'}): ` +
            `${err.message}. The primary address is unaffected.`,
        );
      }
    });
    companionServer.listen(httpPort, companion, () => {
      console.log(`[WebUI] HTTP server running on http://${companionLabel}:${httpPort}`);
    });
  }

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

  // Hot-reload provider credentials when config file changes on disk (another
  // terminal's `wstack auth`, a provider panel in another window, or a manual
  // edit). Rebuild the live agent's provider so the next message uses the
  // new key without restarting the server, and re-broadcast the saved-providers
  // projection so every connected panel re-renders. Mirrors `switchModel`'s
  // live-swap (routes.ts). Escape hatch: WRONGSTACK_DISABLE_CONFIG_WATCH=1.
  //
  // Watches the ACTIVE PROFILE config (~/.wrongstack/profiles/<name>/config.json)
  // where all user settings, providers, and routing configs live. The root
  // bootstrap is deliberately not watched as a settings source.
  const watchConfigPath = profileConfigPath;
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
      watchConfigPath,
      vault,
      (snapshot) => {
        // Refresh in-memory config + store so panels and the next switch read fresh.
        state.setConfig(
          patchConfig(state.getConfig(), {
            providers: snapshot.providers,
            ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
            ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
            fallbackBridge: snapshot.fallbackBridge ?? '',
          }),
        );
        deps.configStore.update({
          providers: snapshot.providers,
          ...(snapshot.apiKey !== undefined ? { apiKey: snapshot.apiKey } : {}),
          ...(snapshot.baseUrl !== undefined ? { baseUrl: snapshot.baseUrl } : {}),
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
  // Build the route table (Phase 1a) + the message dispatcher and connection
  // handler (Phase 1b). The dispatcher owns the inbound `switch (msg.type)`
  // and the runLock guard; the connection handler owns rate-limiting, F5
  // transcript replay, and per-client lifecycle. Both live in their own
  // modules so `startWebUI` reads as orchestration.
  const routes = buildRoutes(state, deps, cb);
  const handleMessage = createMessageDispatcher({
    state,
    deps,
    routes,
    promptsCtx,
    codebaseIndexing,
    runLock: runLockControl,
    pendingConfirms,
  });
  // Fire-and-forget callback wired on the connection lifecycle for
  // `unsafe_key` / `too_deep` decoder rejections. Sends a high-priority
  // mailbox note to leaders so the running agent-loop can respond if
  // configured to alert (e.g. slash handler or tool watcher).
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
      // `events` feeds the audit markers; the load already parsed them.
      return { messages: data.messages, events: data.events, usage: data.usage };
    },
    clients,
    pendingConfirms,
    onSecurityRejection: (ev) => {
      // `try/catch` around a `void`-ed promise only catches a SYNCHRONOUS
      // throw. `mailbox.send` is IPC to the per-project daemon, so a rejection
      // (daemon down, zombie Windows named pipe) escaped as an unhandled
      // rejection and — under Node 22's `--unhandled-rejections=throw` —
      // killed the server. The trigger is one decoder tripwire, i.e. a single
      // frame containing `{"__proto__":{}}`: the security alarm became a
      // one-frame remote DoS. Siblings do it right: client-presence.ts:106.
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
          // Best-effort — a failure here must not crash the message handler
          // or block future messages.
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
  // HTTP server for the React frontend (port 3456) — see `http-server.ts`
  // for the static-serve, MIME matching, path-traversal guard, and CSP
  // header logic. Constructed here, listen()d below alongside the WS server.
  // `globalRoot` powers the /api/sessions and /api/sessions/:id/agents
  // handlers (read the cross-process SessionRegistry); `apiToken` is the
  // shared auth token the HTTP API requires when bound to a non-loopback
  // host (LAN exposure). Loopback binds skip the token check, mirroring
  // the WS verifyClient loopback-bootstrap policy.

  let unregisterShutdown = (): void => {};
  unregisterShutdown = registerShutdown({
    flushSession: async () => {
      await session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: tokenCounter.total(),
      });
      await session.close();
    },
    clients: () => clients.keys(),
    servers: [
      httpServer,
      ...(companionServer ? [companionServer] : []),
      wssPrimary,
      ...(wssSecondary ? [wssSecondary] : []),
    ],
    onShutdown: async () => {
      unregisterShutdown();
      await todosCheckpoint.detach();
      await stopHeapWatchdog();
      credentialWatcherClose?.();
      disposeRealtimeHandlers();
      const governanceCleanup = await governanceHandle?.close();
      if (governanceCleanup && !governanceCleanup.ok) {
        logger.warn(`governance: standalone WebUI ${governanceCleanup.action} cleanup failed`, {
          message: governanceCleanup.message,
        });
      }
      brainMonitor.stop();
      // Read via the services getter — ledger toggles swap the instance.
      await agentServices.brainLedger?.stop().catch(() => {});
      await mcpRegistry.stopAll().catch(() => undefined);
      await sessionIdentity.stop();
      eventArming.getDispose()?.();
      if (eternalSubscription) {
        eternalSubscription.dispose();
        eternalSubscription = null;
      }
      codebaseIndexing.dispose();
      if (config.Sage?.enabled !== false && config.Sage?.hygiene?.autoAfterSession !== false) {
        const candidate = memoryStore as unknown as {
          hygiene?: (options?: object) => Promise<unknown>;
        };
        await candidate
          .hygiene?.({
            retentionDays: config.Sage?.hygiene?.retentionDays,
            archiveLowConfidenceAfterDays: config.Sage?.hygiene?.archiveLowConfidenceAfterDays,
          })
          .catch((err: unknown) =>
            logger.warn(`sage session hygiene failed: ${toErrorMessage(err)}`),
          );
      }
      await memoryStore
        .dispose()
        .catch((err: unknown) =>
          logger.warn(`sage connection disposal failed: ${toErrorMessage(err)}`),
        );
      await unregisterInstance(process.pid, path.dirname(globalConfigPath));
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
