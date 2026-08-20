import type { Container } from '@wrongstack/core/kernel';
import { TOKENS } from '@wrongstack/core/kernel';
import { getSddRuntimeStateForCli } from '../cli-main-helpers.js';
import { createCommandHostAdapters } from './command-host-adapters.js';
import { createEternalCommandHandlers } from './eternal-command-handlers.js';
import { createFleetCommandHandlers } from './fleet-command-handlers.js';
import { createSddHandlers } from './sdd-handlers.js';
import { createSessionCommandHandlers } from './session-command-handlers.js';
import { buildCommandHostSlashCommands } from './slash-commands.js';

// Bag params are typed by their CONSUMERS: every field below flows into
// buildCommandHostSlashCommands — directly or via one of the handler
// factories — so each type is an indexed access of that destination. The
// aliases track the factories automatically when their params change.
type B = Parameters<typeof buildCommandHostSlashCommands>[0];
type A = Parameters<typeof createCommandHostAdapters>[0];
type F = Parameters<typeof createFleetCommandHandlers>[0];
type SE = Parameters<typeof createSessionCommandHandlers>[0];
type E = Parameters<typeof createEternalCommandHandlers>[0];
type SD = Parameters<typeof createSddHandlers>[0];

export function setupCliSlashCommands(params: {
  slashRegistry: B['registry'];
  toolRegistry: B['toolRegistry'];
  agent: A['agent'];
  interruptController: NonNullable<B['interruptController']>;
  reader: A['reader'];
  wpaths: B['paths'];
  container: Container;
  sessionStore: B['sessionStore'];
  skillLoader: B['skillLoader'];
  tokenCounter: B['tokenCounter'];
  renderer: B['renderer'];
  events: B['events'];
  memoryStore: B['memoryStore'];
  /**
   * Vector memory store (semantic recall channel). When supplied, the
   * `/memory diagnostics` and `/memory race` slash commands can
   * surface cross-system health and the lexical vs semantic channel
   * comparison.
   */
  vectorMemoryStore?: B['vectorMemoryStore'];
  context: NonNullable<B['context']>;
  cwd: string;
  projectRoot: string;
  metricsSink: B['metricsSink'];
  healthRegistry: B['healthRegistry'];
  metricsStatus: B['metricsStatus'];
  planPath: string;
  modeStore: B['modeStore'];
  fleetStreamController: B['fleetStreamController'];
  enhanceController: B['enhanceController'];
  provider: B['llmProvider'];
  config: SD['config'];
  buildProviderForId: NonNullable<B['createProvider']>;
  statuslineConfigDeps: B['statuslineConfig'];
  getCurrentHiddenItems: () => NonNullable<B['statuslineHiddenItems']>;
  setStatuslineHiddenItems: NonNullable<B['setStatuslineHiddenItems']>;
  saveStatuslineHiddenItems: NonNullable<B['saveStatuslineHiddenItems']>;
  agentsMonitorController: B['agentsMonitorController'];
  agentMonitor: B['agentMonitor'];
  onPanelOpen: B['onPanelOpen'];
  configStore: B['configStore'];
  secretInputController: {
    readSecret: NonNullable<B['readSecret']>;
    readText: NonNullable<B['readText']>;
  };
  vault: B['vault'];
  brain: B['brain'];
  brainSettings: B['brainSettings'];
  brainRuntime: B['brainRuntime'];
  initialBrainLog: ReturnType<NonNullable<B['getBrainLog']>>;
  coordinatorController: B['coordinatorController'];
  statusTracker: B['statusTracker'];
  shadowController: B['shadowController'];
  multiAgentHost: F['multiAgentHost'];
  director: ReturnType<F['getDirector']>;
  sessionRef: SD['sessionRef'];
  session: SD['session'];
  fleetRootForPromotion: string;
  profileConfigPath: string;
  effectiveMaxContextRef: SE['effectiveMaxContext'];
  autoCompactor: SE['autoCompactor'];
  eventWiring: { setEffectiveMaxContext: SE['setEventMaxContext'] };
  mcpRegistry: SE['mcpRegistry'];
  setYoloMode: SE['onYolo'];
  getNextPredict: SE['getNextPredict'];
  setNextPredict: SE['setNextPredict'];
  getCurrentSuggestions: SE['getCurrentSuggestions'];
  setCurrentSuggestions: SE['setCurrentSuggestions'];
  teardownHandlers: SE['teardownHandlers'];
  pluginHost: SE['pluginHost'];
  logger: SD['logger'];
  flags: SE['flags'];
  errorRing: SE['errorRing'];
  stats: SE['stats'];
  broadcastEternalIteration: E['onIteration'];
  broadcastAutonomyStage: E['onStage'];
  getAutonomyMode: E['getAutonomyMode'];
  setAutonomyMode: E['setAutonomyMode'];
  autonomyModeRef: E['autonomyModeRef'];
  getEternalEngine: E['getEternalEngine'];
  setEternalEngine: E['setEternalEngine'];
  getParallelEngine: E['getParallelEngine'];
  setParallelEngine: E['setParallelEngine'];
  sddRunRegistry: SD['sddRunRegistry'];
  goalHost?: {
    onGoalStart: NonNullable<B['onGoalStart']>;
    onGoalPause: NonNullable<B['onGoalPause']>;
    onGoalResume: NonNullable<B['onGoalResume']>;
    onGoalStop: NonNullable<B['onGoalStop']>;
    getGoalRunner: NonNullable<B['getGoalRunner']>;
    onGoalMoveTask: NonNullable<B['onGoalMoveTask']>;
    onGoalAssignTask: NonNullable<B['onGoalAssignTask']>;
    onGoalAddTask: NonNullable<B['onGoalAddTask']>;
    onGoalRetryTask: NonNullable<B['onGoalRetryTask']>;
    onWorktree: NonNullable<B['onWorktree']>;
  };
  setConfig: SE['setConfig'];
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
    vectorMemoryStore,
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
    initialBrainLog,
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
    vectorMemoryStore,
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
    ...(enhanceController ? { enhanceController } : {}),
    llmProvider: provider,
    llmModel: config.model,
    createProvider: (pid: string) => {
      try {
        return buildProviderForId(pid);
      } catch {
        return undefined;
      }
    },
    ...(statuslineConfigDeps ? { statuslineConfig: statuslineConfigDeps } : {}),
    statuslineHiddenItems: [...getCurrentHiddenItems()],
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    ...(agentsMonitorController ? { agentsMonitorController } : {}),
    ...(agentMonitor ? { agentMonitor } : {}),
    onPanelOpen,
    configStore,
    reader,
    readSecret: secretInputController.readSecret,
    readText: secretInputController.readText,
    vault,
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog: () => initialBrainLog,
    ...(coordinatorController ? { coordinatorController } : {}),
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
    ...(goalHost
      ? {
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
        }
      : {}),
  });

  for (const cmd of slashCmds) {
    slashRegistry.register(cmd);
  }
}
