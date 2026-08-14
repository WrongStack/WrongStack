import { TOKENS } from '@wrongstack/core/kernel';
import { createCommandHostAdapters } from './command-host-adapters.js';
import { createEternalCommandHandlers } from './eternal-command-handlers.js';
import { createFleetCommandHandlers } from './fleet-command-handlers.js';
import { createSddHandlers } from './sdd-handlers.js';
import { createSessionCommandHandlers } from './session-command-handlers.js';
import { buildCommandHostSlashCommands } from './slash-commands.js';
import { getSddRuntimeStateForCli } from '../cli-main-helpers.js';

export function setupCliSlashCommands(params: {
  slashRegistry: any;
  toolRegistry: any;
  agent: any;
  interruptController: any;
  reader: any;
  wpaths: any;
  container: any;
  sessionStore: any;
  skillLoader: any;
  tokenCounter: any;
  renderer: any;
  events: any;
  memoryStore: any;
  context: any;
  cwd: string;
  projectRoot: string;
  metricsSink: any;
  healthRegistry: any;
  metricsStatus: any;
  planPath: string;
  modeStore: any;
  fleetStreamController: any;
  enhanceController: any;
  provider: any;
  config: any;
  buildProviderForId: (pid: string) => any;
  statuslineConfigDeps: any;
  getCurrentHiddenItems: () => any[];
  setStatuslineHiddenItems: any;
  saveStatuslineHiddenItems: any;
  agentsMonitorController: any;
  agentMonitor: any;
  onPanelOpen: any;
  configStore: any;
  secretInputController: any;
  vault: any;
  brain: any;
  brainSettings: any;
  brainRuntime: any;
  brainLog: any;
  coordinatorController: any;
  statusTracker: any;
  shadowController: any;
  multiAgentHost: any;
  director: any;
  sessionRef: any;
  session: any;
  fleetRootForPromotion: string;
  profileConfigPath: string;
  effectiveMaxContextRef: any;
  autoCompactor: any;
  eventWiring: any;
  mcpRegistry: any;
  setYoloMode: (setTo?: boolean) => boolean;
  getNextPredict: () => boolean;
  setNextPredict: (enabled: boolean) => void;
  getCurrentSuggestions: () => any;
  setCurrentSuggestions: (s: any) => void;
  teardownHandlers: Array<() => void>;
  pluginHost: any;
  logger: any;
  flags: any;
  errorRing: any;
  stats: any;
  broadcastEternalIteration: any;
  broadcastAutonomyStage: any;
  getAutonomyMode: () => any;
  setAutonomyMode: (m: any) => void;
  autonomyModeRef: any;
  getEternalEngine: () => any;
  setEternalEngine: (e: any) => void;
  getParallelEngine: () => any;
  setParallelEngine: (e: any) => void;
  sddRunRegistry: any;
  goalHost: any;
  setConfig: (cfg: any) => void;
}) {
  const {
    slashRegistry,
    toolRegistry,
    agent,
    interruptController,
    reader,
    wpaths,
    container,
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    events,
    memoryStore,
    context,
    cwd,
    projectRoot,
    metricsSink,
    healthRegistry,
    metricsStatus,
    planPath,
    modeStore,
    fleetStreamController,
    enhanceController,
    provider,
    config,
    buildProviderForId,
    statuslineConfigDeps,
    getCurrentHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    agentsMonitorController,
    agentMonitor,
    onPanelOpen,
    configStore,
    secretInputController,
    vault,
    brain,
    brainSettings,
    brainRuntime,
    brainLog,
    coordinatorController,
    statusTracker,
    shadowController,
    multiAgentHost,
    director,
    sessionRef,
    session,
    fleetRootForPromotion,
    profileConfigPath,
    effectiveMaxContextRef,
    autoCompactor,
    eventWiring,
    mcpRegistry,
    setYoloMode,
    getNextPredict,
    setNextPredict,
    getCurrentSuggestions,
    setCurrentSuggestions,
    teardownHandlers,
    pluginHost,
    logger,
    flags,
    errorRing,
    stats,
    broadcastEternalIteration,
    broadcastAutonomyStage,
    getAutonomyMode,
    setAutonomyMode,
    autonomyModeRef,
    getEternalEngine,
    setEternalEngine,
    getParallelEngine,
    setParallelEngine,
    sddRunRegistry,
    goalHost,
    setConfig,
  } = params;

  const slashCmds = buildCommandHostSlashCommands({
    registry: slashRegistry,
    toolRegistry,
    ...createCommandHostAdapters({ agent, toolRegistry, interruptController, reader }),
    paths: wpaths,
    compactor: container.resolve(TOKENS.Compactor),
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    events,
    memoryStore,
    context,
    cwd,
    projectRoot,
    metricsSink,
    healthRegistry,
    metricsStatus,
    planPath,
    modeStore,
    fleetStreamController,
    interruptController,
    enhanceController,
    llmProvider: provider,
    llmModel: config.model,
    createProvider: (pid: string) => {
      try {
        return buildProviderForId(pid);
      } catch {
        return undefined;
      }
    },
    statuslineConfig: statuslineConfigDeps,
    statuslineHiddenItems: [...getCurrentHiddenItems()],
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    agentsMonitorController,
    agentMonitor,
    onPanelOpen,
    configStore,
    reader,
    readSecret: (prompt) => secretInputController.readSecret(prompt),
    readText: (prompt) => secretInputController.readText(prompt),
    vault,
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog: () => brainLog,
    coordinatorController,
    statusTracker,
    shadowController,
    ...createFleetCommandHandlers({
      multiAgentHost,
      getDirector: () => director,
      events,
      getSessionId: () => sessionRef.current?.id ?? session.id,
      fleetRoot: fleetRootForPromotion,
    }),
    ...createSessionCommandHandlers({
      getConfig: () => config,
      setConfig,
      configStore,
      profileConfigPath,
      context,
      effectiveMaxContext: effectiveMaxContextRef,
      autoCompactor,
      events,
      setEventMaxContext: eventWiring.setEffectiveMaxContext,
      mcpRegistry,
      onYolo: setYoloMode,
      getNextPredict,
      setNextPredict,
      getCurrentSuggestions,
      setCurrentSuggestions,
      teardownHandlers,
      multiAgentHost,
      pluginHost,
      logger,
      projectRoot,
      flags,
      tokenCounter,
      errorRing,
      toolRegistry,
      stats,
    }),
    ...createEternalCommandHandlers({
      agent,
      projectRoot,
      compactor: container.resolve(TOKENS.Compactor),
      effectiveMaxContext: effectiveMaxContextRef,
      onIteration: broadcastEternalIteration,
      onStage: broadcastAutonomyStage,
      multiAgentHost,
      getConfig: () => config,
      events,
      logger,
      brain,
      getAutonomyMode,
      setAutonomyMode,
      autonomyModeRef,
      getEternalEngine,
      setEternalEngine,
      getParallelEngine,
      setParallelEngine,
    }),
    ...createSddHandlers({
      wpaths,
      projectRoot,
      events,
      sessionRef,
      session,
      renderer,
      multiAgentHost,
      config,
      brain,
      agent,
      logger,
      sddRunRegistry,
      getSddRuntimeState: getSddRuntimeStateForCli,
    }),
    onGoalStart: goalHost.onGoalStart,
    onGoalPause: goalHost.onGoalPause,
    onGoalResume: goalHost.onGoalResume,
    onGoalStop: goalHost.onGoalStop,
    getGoalRunner: goalHost.getGoalRunner,
    onGoalMoveTask: goalHost.onGoalMoveTask,
    onGoalAssignTask: goalHost.onGoalAssignTask,
    onGoalAddTask: goalHost.onGoalAddTask,
    onGoalRetryTask: goalHost.onGoalRetryTask,
    onWorktree: goalHost.onWorktree,
  });

  for (const cmd of slashCmds) {
    slashRegistry.register(cmd);
  }
}
