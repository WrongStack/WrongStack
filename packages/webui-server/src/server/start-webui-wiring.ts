import { DefaultConfigLoader } from '@wrongstack/core/storage';
import { startSharedHeapWatchdog } from '@wrongstack/core/utils';
import { fleetSpawnCallbacks } from '@wrongstack/runtime/commands';
import type { WebSocket } from 'ws';
import type { createAgentServices } from './backend-services.js';
import { createConnectionHandler } from './connection-handler.js';
import { registerEngineManagementTools } from './management-tools.js';
import { createMessageDispatcher } from './message-dispatcher.js';
import { createApplyModelSwitch, createSessionContextResolver } from './model-switch-core.js';
import type { PendingConfirm } from './pending-confirms.js';
import type { createPreContextServices } from './pre-context-services.js';
import {
  buildRoutes,
  type WebuiCallbacks,
  type WebuiDeps,
  type WebuiMutableState,
} from './routes.js';
import {
  type StandaloneHostServices,
  startStandaloneHostServices,
} from './standalone-host-services.js';
import { setupWebuiCredentialWatcher } from './start-webui-credential-watcher.js';
import { createWebuiDeps } from './start-webui-deps.js';
import { setupWebuiTerminalLogging } from './start-webui-logging.js';
import { setupWebuiProxyInstantApply } from './start-webui-proxy-apply.js';
import { handleWebuiSecurityRejection } from './start-webui-security.js';
import { setupStandaloneSessionMaintenance } from './start-webui-session-maintenance.js';
import type { createRunLockControl } from './start-webui-session-runtime.js';
import { setupWebuiShutdown } from './start-webui-shutdown.js';
import type { ConnectedClient, WebUIOptions } from './types.js';
import { broadcast } from './ws-utils.js';

type PreContext = Awaited<ReturnType<typeof createPreContextServices>>;
type AgentServices = Awaited<ReturnType<typeof createAgentServices>>;
type ShutdownOptions = Parameters<typeof setupWebuiShutdown>[0];
type MaintenanceLogger = Parameters<typeof setupStandaloneSessionMaintenance>[0]['logger'];

export interface StandaloneWebuiWiringInput {
  opts: WebUIOptions;
  state: WebuiMutableState;
  deps: WebuiDeps;
  cb: WebuiCallbacks;
  preContext: PreContext;
  agentServices: AgentServices;
  clients: Map<WebSocket, ConnectedClient>;
  pendingConfirms: Map<string, PendingConfirm>;
  runLockControl: ReturnType<typeof createRunLockControl>;
  profileConfigPath: string;
  vault: WebuiDeps['vault'];
  logger: MaintenanceLogger;
  wsHost: string | undefined;
  httpPort: number;
  accessToken: string;
  publicUrl: string | undefined;
  sessionStartPayload: Parameters<typeof createConnectionHandler>[0]['sessionStartPayload'];
  otlpExport: { stop: () => Promise<void> } | undefined;
  httpServer: ShutdownOptions['httpServer'];
  companionServer: ShutdownOptions['companionServer'];
  wssPrimary: ShutdownOptions['wssPrimary'];
  wssSecondary: ShutdownOptions['wssSecondary'];
  todosCheckpoint: ShutdownOptions['todosCheckpoint'];
  governanceHandle: ShutdownOptions['governanceHandle'];
  eventArming: ShutdownOptions['eventArming'];
  getEternalSubscription: ShutdownOptions['getEternalSubscription'];
  clearEternalSubscription: ShutdownOptions['clearEternalSubscription'];
  memoryStore: ShutdownOptions['memoryStore'];
  vectorMemoryStore: ShutdownOptions['vectorMemoryStore'];
  getDisposeVectorMirror: () => (() => void) | undefined;
  disposeChronicle?: ShutdownOptions['disposeChronicle'];
  globalConfigPath: string;
  configPaths: import('@wrongstack/core/utils').WstackPaths;
}

/**
 * Final wiring phase of `startWebUI`, run once the mutable state, deps and
 * callbacks exist: credential watcher, proxy instant-apply, heap watchdog,
 * terminal logging, routes + message dispatcher, the WS connection handler,
 * and graceful-shutdown registration. Session reads go through `state`, the
 * same live bindings `startWebUI` reassigns.
 */
export function wireStandaloneWebuiRuntime(
  input: StandaloneWebuiWiringInput,
): Pick<StandaloneHostServices, 'switchProject'> {
  const {
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
    getEternalSubscription,
    clearEternalSubscription,
    memoryStore,
    vectorMemoryStore,
    getDisposeVectorMirror,
    disposeChronicle,
    globalConfigPath,
    configPaths,
  } = input;
  const { context, events, promptsCtx, tokenCounter, mcpRegistry, sessionIdentity } = preContext;
  const {
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
    brainMonitor,
  } = agentServices;

  const liveConfigLoader = new DefaultConfigLoader({ paths: configPaths, vault, logger });
  const credentialWatcherClose = setupWebuiCredentialWatcher({
    watchConfigPath: profileConfigPath,
    loadConfig: () => liveConfigLoader.load({ skipIdentityValidation: true }),
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

  // WebUI joins the process flight recorder, including standalone servers.
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
    surface: opts.surface,
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
  // The leader's provider/model/fallback management tools (CLI parity). A write is persisted
  // through the serialized config writer and applied live; a model switch targets the tab whose
  // leader called the tool, through the same switch `model.switch` uses.
  const sessionContextForTool = createSessionContextResolver(deps);
  const switchModelForTool = createApplyModelSwitch(state, deps, cb, sessionContextForTool);
  registerEngineManagementTools({
    toolRegistry: deps.toolRegistry,
    getConfig: () => state.getConfig(),
    applyConfig: (next) => {
      state.setConfig(next);
      deps.configStore.replace(next);
    },
    persist: (mutate) => cb.updateGlobalConfig(mutate, 'management tool'),
    switchModel: switchModelForTool,
    modelsRegistry: deps.modelsRegistry,
    events,
    onTierProposed: (sessionId, proposal) =>
      broadcast(state.getClients(), {
        type: 'model.tier_proposed',
        payload: { ...proposal, ...(sessionId ? { sessionId } : {}) },
      }),
    sessionModel: (sessionId) => {
      const ctx = sessionContextForTool(sessionId);
      return { provider: ctx.provider.id, model: ctx.model };
    },
  });
  const { stopEmptySessionCleanup, offSessionRenamed } = setupStandaloneSessionMaintenance({
    state,
    clients,
    collabHandler,
    logger,
    events,
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
    updateGlobalConfig: cb.updateGlobalConfig,
    onDispose: (dispose) => {
      kanbanSupervisorDispose = dispose;
    },
  });

  const handleConnection = createConnectionHandler({
    getSessionId: () => state.getSession().id,
    sessionStartPayload,
    tokenCounter,
    context,
    loadReplay: async () => {
      await state.getSession().flush();
      const data = await state.getSessionStore().load(state.getSession().id);
      return { messages: data.messages, events: data.events, usage: data.usage };
    },
    loadAgentSessions: deps.loadAgentSessions,
    clients,
    pendingConfirms,
    onSecurityRejection: (ev) =>
      handleWebuiSecurityRejection(context, events, state.getSession(), ev),
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

  // HQ control + presence and the dependency watcher's audits (CLI parity).
  const hostServices = startStandaloneHostServices({
    state,
    deps,
    preContext,
    agentServices,
    runLockControl,
    paths: configPaths,
  });

  setupWebuiShutdown({
    stopTelemetryExport: otlpExport ? () => otlpExport.stop() : undefined,
    getSession: () => state.getSession(),
    tokenCounter,
    clients,
    httpServer,
    companionServer,
    wssPrimary,
    wssSecondary,
    stopEmptySessionCleanup: {
      dispose: async () => {
        offSessionRenamed();
        await stopEmptySessionCleanup.dispose();
      },
    },
    getKanbanSupervisorDispose: () => kanbanSupervisorDispose,
    stopHostServices: () => hostServices.dispose(),
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
    getEternalSubscription,
    clearEternalSubscription,
    codebaseIndexing,
    memoryStore,
    vectorMemoryStore,
    disposeVectorMirror: () => getDisposeVectorMirror()?.(),
    disposeChronicle,
    flushSessionJournalsSync: agentServices.flushSessionJournalsSync,
    closeSessionJournals: agentServices.closeSessionJournals,
    globalConfigPath,
  });
  return { switchProject: (projectRoot) => hostServices.switchProject(projectRoot) };
}

/**
 * Build the route-layer `WebuiDeps` from the pre-context + agent services
 * plus the host-level pieces `startWebUI` owns (sockets, paths, auth).
 */
export function buildStandaloneWebuiDeps(input: {
  preContext: PreContext;
  agentServices: AgentServices;
  trustBoundary: WebuiDeps['trustBoundary'];
  clients: Map<WebSocket, ConnectedClient>;
  vault: WebuiDeps['vault'];
  globalConfigPath: string;
  profileConfigPath: string;
  wpaths: WebuiDeps['wpaths'];
  pendingConfirms: Map<string, PendingConfirm>;
  logger: WebuiDeps['logger'];
  memoryStore: WebuiDeps['memoryStore'];
  wsHost: string | undefined;
  requireToken: boolean | undefined;
  publicUrl: string | undefined;
  publicWsUrl: string | undefined;
  httpPort: number;
  wssPrimary: WebuiDeps['wssPrimary'];
  wssSecondary: WebuiDeps['wssSecondary'];
  autoWake?: WebuiDeps['autoWake'];
}): WebuiDeps {
  const {
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
  } = input;
  const {
    context,
    container,
    toolRegistry,
    modelsRegistry,
    providerRegistry,
    provider,
    mcpRegistry,
    configStore,
    tokenCounter,
    modeStore,
    skillLoader,
    skillInstaller,
    customModeStore,
    events,
  } = preContext;
  const {
    agent,
    getAgent,
    peekAgent,
    sessionAgentIds,
    isSessionLive,
    permissionPolicy,
    pipelines,
    compactor,
    autoCompactor,
    subagentFactory,
    goalHandler,
    kanbanRunMirror,
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
  } = agentServices;
  return createWebuiDeps({
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
    subagentFactory,
    goalHandler,
    kanbanRunMirror,
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
    ...(input.autoWake ? { autoWake: input.autoWake } : {}),
    // The engine's fleet host starts the workers `/spawn` and `/delegate` ask for, and its
    // agent monitor gives a reopened conversation its workers' transcripts back.
    ...(agentServices.delegation
      ? {
          loadAgentSessions: agentServices.delegation.loadAgentSessions,
          fleetCommands: fleetSpawnCallbacks({
            host: agentServices.delegation.host,
            getDirector: () => agentServices.delegation?.host.getDirector(),
            getSessionId: () => context.session.id,
          }),
        }
      : {}),
  });
}
