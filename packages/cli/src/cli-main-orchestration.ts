import { TOKENS } from '@wrongstack/contracts/kernel';
import { mailboxSessionTag } from '@wrongstack/coordination';
import { createPolicySandboxApprover, setSandboxExpansionApprover } from '@wrongstack/core/sandbox';
import { resolveExecutionMode } from './boot/execution-mode.js';
import { isSafeMode } from './boot/safe-mode.js';
import type { CliContext } from './cli-context.js';
import { launchEternalFromFlag } from './cli-eternal-flag.js';
import type { CliBootResult } from './cli-main-boot.js';
import type { CliConfigState, CliRunState } from './cli-main-state.js';
import { setupBrainAndOrchestration } from './wiring/brain-and-orchestration.js';
import { setupCliSlashCommands } from './wiring/cli-slash-commands-setup.js';
import { setupCommandHostState } from './wiring/command-host-state.js';
import { setupDepWatcherConsumers } from './wiring/dep-watcher.js';
import { ensureDirectorAndAnnounce } from './wiring/director-announcement.js';
import { setupDirectorAndAutonomy } from './wiring/director-setup.js';
import { setupCliHeapWatchdog } from './wiring/heap-watchdog-setup.js';
import { setupHqTelemetry } from './wiring/hq-telemetry.js';
import { prepareRuntimeDispatch } from './wiring/runtime-dispatch-state.js';

export async function wireCliOrchestration(
  cliCtx: CliContext,
  state: CliConfigState,
  boot: CliBootResult,
) {
  const {
    vault,
    wpaths,
    cwd,
    projectRoot,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
    events,
    container,
    approvalMirror,
    configStore,
  } = cliCtx;
  const {
    profileConfigPath,
    modeStore,
    providerRegistry,
    provider,
    modeId,
    memoryStore,
    teardownHandlers,
    vectorMemoryStore,
    skillLoader,
    sessionRef,
    autonomyModeRef,
    toolRegistry,
    metricsSink,
    healthRegistry,
    metricsStatus,
    tracer,
    tuiOwnsScreen,
    evOn,
    eventWiring,
    promptBuilder,
    sessionStore,
    tokenCounter,
    context,
    planPath,
    session,
    priorFleetState,
    sessResult,
    governanceHandle,
    tracker,
    errorRing,
    stats,
    pipelines,
    autoCompactor,
    effectiveMaxContextRef,
    agent,
    mcpRegistry,
    slashRegistry,
    hqPublisherRef,
    brainMailbox,
    pluginHost,
    dwCfg,
    statusTracker,
    buildProviderForId,
    memoryCuratorLlm,
  } = boot;
  const directorAutonomy = setupDirectorAndAutonomy({
    flags,
    config: state.config,
    wpaths,
    session,
    events,
    autonomyModeRef,
  });
  const run: CliRunState = {
    director: directorAutonomy.director,
    autonomyMode: directorAutonomy.autonomyMode,
    nextPredictEnabled: directorAutonomy.nextPredictEnabled,
    currentSuggestions: directorAutonomy.currentSuggestions,
    eternalEngine: directorAutonomy.eternalEngine,
    parallelEngine: directorAutonomy.parallelEngine,
  };
  const {
    maxConcurrent,
    maxSpawns,
    maxConcurrentSource,
    maxSpawnsSource,
    eternalListeners,
    broadcastEternalIteration,
    stageListeners,
    broadcastAutonomyStage,
    fleetRoot,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
    stateCheckpointPath,
    fleetRootForPromotion,
    agentMonitor,
  } = directorAutonomy;

  const {
    brain,
    brainLog,
    brainTierStats,
    brainSettings,
    brainRuntime,
    multiAgentHost,
    shadowController,
  } = setupBrainAndOrchestration({
    tracer,
    events,
    config: state.config,
    vault,
    container,
    provider,
    session,
    context,
    toolRegistry,
    providerRegistry,
    configStore,
    modelsRegistry,
    promptBuilder,
    tokenCounter,
    skillLoader: state.config.features.skills && !isSafeMode(flags) ? skillLoader : undefined,
    projectRoot,
    cwd,
    wpaths,
    teardownHandlers,
    mailboxSessionTag,
    brainMailbox,
    agentMonitor,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
    stateCheckpointPath,
    fleetRootForPromotion,
    maxConcurrent,
    maxSpawns,
    maxConcurrentSource,
    maxSpawnsSource,
    effectiveMaxContextRef,
    mcpRegistry,
    sessResult,
    modeId,
    statusTracker,
    ...(governanceHandle ? { installToolBoundary: governanceHandle.installToolBoundary } : {}),
  });

  const { hqCommandController } = setupHqTelemetry({
    events,
    session,
    config: state.config,
    flags,
    tuiOwnsScreen,
    projectRoot,
    globalRoot: wpaths.globalRoot,
    tracker,
    agentMonitor,
    brainMailbox,
    teardownHandlers,
    mailboxSessionTag,
    hqPublisherRef,
    approvalMirror,
    mcpRegistry,
    liveSession: () => context.session ?? session,
    liveProjectRoot: () => context.projectRoot ?? projectRoot,
    getConfig: () => configStore.get(),
  });

  setupDepWatcherConsumers({
    dwCfg,
    globalRoot: wpaths.globalRoot,
    projectSlug: wpaths.projectSlug,
    events,
    multiAgentHost,
    sessionId: session.id,
    logger,
    teardownHandlers,
    projectRoot,
  });

  run.director = await ensureDirectorAndAnnounce({
    logger,
    multiAgentHost,
    priorFleetState,
    renderer,
    toolRegistry,
    flags,
    fleetRoot,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
    announce: state.config.startupAnnounce !== false,
  });

  const {
    fleetStreamController,
    interruptController,
    enhanceController,
    statuslineConfigDeps,
    statuslineHiddenItems,
    getCurrentHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    statuslineLines,
    setStatuslineLines,
    saveStatuslineLines,
    statuslineDensities,
    setStatuslineDensities,
    saveStatuslineDensities,
    statuslineOrder,
    setStatuslineOrder,
    saveStatuslineOrder,
    agentsMonitorController,
    onPanelOpen,
    goalHost,
    coordinatorController,
    setYoloMode,
    setYoloPlusMode,
    setYoloConfirm,
    secretInputController,
    sddRunRegistry,
  } = await setupCommandHostState({
    getConfig: () => state.config,
    setConfig: (nextConfig: typeof state.config) => {
      state.config = nextConfig;
    },
    getDirector: () => run.director,
    hqCommandController,
    hqMultiConversation: resolveExecutionMode(positional, flags) === 'webui',
    multiAgentHost,
    events,
    sessionRef,
    session,
    paths: wpaths,
    projectRoot,
    brain,
    renderer,
    reader,
    permissionPolicy: container.resolve(TOKENS.PermissionPolicy),
    contextMeta: agent.ctx.meta,
    configStore,
  });
  // YOLO+ from the profile or `--yolo-plus`: move the policy, the conversation
  // meta (the TUI chip reads it) and the live store subagents read together.
  if (state.config.autonomy?.yoloPlus === true) setYoloPlusMode(true);

  // Plan 28 T6 — expansion approvals ride the standard permission policy
  // (trust rules / YOLO / prompt delegate) via a `sandbox-expansion` pseudo-tool;
  // no new Brain option contract.
  setSandboxExpansionApprover(
    createPolicySandboxApprover(() => container.resolve(TOKENS.PermissionPolicy)),
  );

  setupCliSlashCommands({
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
    config: state.config,
    buildProviderForId,
    statuslineConfigDeps,
    getCurrentHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    agentsMonitorController,
    agentMonitor,
    onPanelOpen,
    configStore,
    // `/profile switch` mutates the store; adopt the resulting config into the
    // host's own `config` closure exactly the way setupProviderRuntime's
    // onConfigUpdate does, so the two copies cannot drift apart.
    onActiveProfileChange: (nextConfig) => {
      state.config = nextConfig;
    },
    secretInputController,
    vault,
    brain,
    brainSettings,
    brainRuntime,
    initialBrainLog: brainLog,
    brainTierStats,
    coordinatorController,
    statusTracker,
    shadowController,
    multiAgentHost,
    director: run.director,
    sessionRef,
    session,
    fleetRootForPromotion,
    profileConfigPath,
    effectiveMaxContextRef,
    autoCompactor,
    eventWiring,
    mcpRegistry,
    setYoloMode,
    setYoloPlusMode,
    setYoloConfirm,
    getNextPredict: () => run.nextPredictEnabled,
    setNextPredict: (enabled) => {
      run.nextPredictEnabled = enabled;
    },
    getCurrentSuggestions: () => run.currentSuggestions,
    setCurrentSuggestions: (suggestions) => {
      run.currentSuggestions = suggestions;
    },
    teardownHandlers,
    pluginHost,
    logger,
    flags,
    errorRing,
    stats,
    broadcastEternalIteration,
    broadcastAutonomyStage,
    getAutonomyMode: () => run.autonomyMode,
    setAutonomyMode: (mode) => {
      run.autonomyMode = mode;
    },
    autonomyModeRef,
    getEternalEngine: () => run.eternalEngine,
    setEternalEngine: (engine) => {
      run.eternalEngine = engine;
    },
    getParallelEngine: () => run.parallelEngine,
    setParallelEngine: (engine) => {
      run.parallelEngine = engine;
    },
    sddRunRegistry,
    goalHost,
    setConfig: (nextConfig) => {
      state.config = nextConfig;
    },
  });

  const eternalFlag =
    typeof flags['eternal'] === 'string' ? (flags['eternal'] as string).trim() : '';
  const configRef = { current: state.config };
  await launchEternalFromFlag({
    eternalFlag,
    projectRoot,
    agent,
    container,
    renderer,
    broadcastEternalIteration,
    effectiveMaxContext: effectiveMaxContextRef.current,
    configRef,
    autonomyModeRef,
    logger,
    eternalEngineRef: {
      get current() {
        return run.eternalEngine ?? undefined;
      },
      set current(engine) {
        run.eternalEngine = engine ?? null;
      },
    },
  });
  state.config = configRef.current;
  if (eternalFlag.length > 0) {
    run.autonomyMode = 'eternal';
  }

  const {
    runSageSessionHygiene,
    getPluginItems: getPluginPickerItems,
    togglePlugin: togglePluginFromPicker,
    getToolItems: getToolPickerItems,
  } = await prepareRuntimeDispatch({
    getConfig: () => state.config,
    setConfig: (nextConfig) => {
      state.config = nextConfig;
    },
    configStore,
    profileConfigPath,
    pipelines,
    memoryStore,
    skillLoader: state.config.features.skills && !isSafeMode(flags) ? skillLoader : undefined,
    logger,
    events,
    agent,
    context,
    projectRoot,
    toolRegistry,
    flags,
    onEvent: evOn,
    memoryCuratorLlm,
  });

  const savedProviderCfg = state.config.providers?.[state.config.provider];

  setupCliHeapWatchdog({
    flags,
    tuiOwnsScreen,
    context,
    metricsSink,
    hqPublisherRef,
    brainMailbox,
    teardownHandlers,
  });

  return {
    agentMonitor,
    brain,
    brainLog,
    brainRuntime,
    brainSettings,
    configRef,
    coordinatorController,
    enhanceController,
    eternalListeners,
    fleetStreamController,
    getPluginPickerItems,
    getToolPickerItems,
    interruptController,
    multiAgentHost,
    onPanelOpen,
    run,
    runSageSessionHygiene,
    saveStatuslineDensities,
    saveStatuslineHiddenItems,
    saveStatuslineLines,
    saveStatuslineOrder,
    savedProviderCfg,
    sddRunRegistry,
    secretInputController,
    setStatuslineDensities,
    setStatuslineHiddenItems,
    setStatuslineLines,
    setStatuslineOrder,
    setYoloMode,
    stageListeners,
    statuslineDensities,
    statuslineHiddenItems,
    statuslineLines,
    statuslineOrder,
    togglePluginFromPicker,
  };
}
