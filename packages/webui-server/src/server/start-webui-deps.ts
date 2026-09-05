import type { WebSocket } from 'ws';
import type { WebuiCallbacks, WebuiDeps } from './routes.js';
import type { ConnectedClient } from './types.js';

export function createWebuiDeps(params: {
  trustBoundary: any;
  agent: any;
  getAgent?: any;
  peekAgent?: any;
  sessionAgentIds?: any;
  isSessionLive?: any;
  clients: Map<WebSocket, ConnectedClient>;
  context: any;
  container: any;
  toolRegistry: any;
  modelsRegistry: any;
  providerRegistry: any;
  provider: any;
  mcpRegistry: any;
  vault: any;
  globalConfigPath: string;
  profileConfigPath: string;
  wpaths: any;
  configStore: any;
  tokenCounter: any;
  permissionPolicy: any;
  pendingConfirms: any;
  pipelines: any;
  logger: any;
  memoryStore: any;
  modeStore: any;
  skillLoader: any;
  skillInstaller: any;
  customModeStore: any;
  compactor: any;
  autoCompactor: any;
  events: any;
  wsHost?: string | undefined;
  requireToken?: boolean | undefined;
  publicUrl?: string | undefined;
  publicWsUrl?: string | undefined;
  httpPort: number;
  wssPrimary: any;
  wssSecondary?: any;
  goalHandler: any;
  specsHandler: any;
  sddBoardHandler: any;
  sddWizardHandler: any;
  worktreeHandler: any;
  collabHandler: any;
  terminalHandler: any;
  brain: any;
  brainSettings: any;
  brainRuntime: any;
  brainLog: any;
}): WebuiDeps {
  const {
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
  } = params;

  return {
    trustBoundary,
    agent,
    getAgent,
    ...(peekAgent ? { peekAgent } : {}),
    ...(sessionAgentIds ? { sessionAgentIds } : {}),
    ...(isSessionLive ? { isSessionLive } : {}),
    hasSession: (id: string) =>
      id === agent.ctx.session?.id ||
      Boolean(peekAgent?.(id)) ||
      [...clients.values()].some((c) => c.sessionId === id || c.sessionIds?.has(id) === true),
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
    wsHost: wsHost ?? '127.0.0.1',
    requireToken: Boolean(requireToken),
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
}

export function createWebuiCallbacks(params: {
  sessionStartPayload: any;
  sessionIdentity: any;
  todosCheckpoint: any;
  deps: any;
  updateAutoCompactionMaxContext: WebuiCallbacks['updateAutoCompactionMaxContext'];
  updateGlobalConfig: (
    mutate: (cfg: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  persistPrefsToConfig: (payload: Record<string, unknown>) => Promise<void>;
  prefSnapshot: () => Record<string, unknown>;
}): WebuiCallbacks {
  const {
    sessionStartPayload,
    sessionIdentity,
    todosCheckpoint,
    deps,
    updateAutoCompactionMaxContext,
    updateGlobalConfig,
    persistPrefsToConfig,
    prefSnapshot,
  } = params;

  return {
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
}
