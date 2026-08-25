/** Top-level CLI phase orchestrator. */
import { mailboxSessionTag } from '@wrongstack/core/coordination';
import { TOKENS } from '@wrongstack/core/kernel';
import type { SystemPromptBuilder } from '@wrongstack/core/types';
import { writeErr } from '@wrongstack/core/utils';
import { wireEventWiring } from './boot/event-wiring.js';
import { resolveModeAndCapabilities } from './boot/system-prompt.js';
import type { CliContext } from './cli-context.js';
import { launchEternalFromFlag } from './cli-eternal-flag.js';
import { loadOnlineAgentsForPrompt } from './cli-main-helpers.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { CLI_VERSION } from './version.js';
import { setupBrainAndOrchestration } from './wiring/brain-and-orchestration.js';
import { runCliExecution } from './wiring/cli-execute-builder.js';
import { setupCliPromptAndTools } from './wiring/cli-prompt-and-tools-setup.js';
import { setupCliSlashCommands } from './wiring/cli-slash-commands-setup.js';
import { setupCommandHostState } from './wiring/command-host-state.js';
import { setupDepWatcherConsumers } from './wiring/dep-watcher.js';
import { setupDepWatcherBridge } from './wiring/dep-watcher-bridge.js';
import { ensureDirectorAndAnnounce } from './wiring/director-announcement.js';
import { setupDirectorAndAutonomy } from './wiring/director-setup.js';
import { setupCliHeapWatchdog } from './wiring/heap-watchdog-setup.js';
import { setupHqTelemetry } from './wiring/hq-telemetry.js';
import { setupLifecycleAndPlugins } from './wiring/lifecycle-plugins.js';
import { registerCliManagementTools } from './wiring/management-tools.js';
import { setupMetrics } from './wiring/metrics.js';
import {
  buildProviderForId as buildProviderForIdRuntime,
  resolveProviderCfg as resolveProviderCfgRuntime,
} from './wiring/provider-runtime.js';
import { setupProviderRuntime } from './wiring/provider-runtime-setup.js';
import { setupProviderStatus } from './wiring/provider-status.js';
import {
  adoptResumedProvider,
  registerProviderUtilityTools,
} from './wiring/provider-utility-tools.js';
import { setProxyTransitionLogger } from '@wrongstack/core/wiring/proxy-rewrite';
import { bootstrapWrongProxy, awaitFirstWrongProxyProbe } from './wiring/proxy-wiring.js';
import { setupReplayAndGovernance } from './wiring/replay-governance-setup.js';
import { prepareRuntimeDispatch } from './wiring/runtime-dispatch-state.js';
import { setupSessionEstablishment } from './wiring/session-establishment.js';
import { setupSessionRegistry } from './wiring/session-registry.js';
import { setupSessionRuntime } from './wiring/session-runtime.js';
import { setupTeardownRegistrar } from './wiring/teardown-registrar.js';
import { setupVectorMemory } from './wiring/vector-memory-setup.js';

export { CLI_VERSION };

/**
 * Everything the CLI needs once it knows it is running an interactive session.
 */
export async function runInteractive(cliCtx: CliContext): Promise<number> {
  let {
    config,
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
    needsSetup,
    events,
    container,
    configStore,
    updateInfo,
    webuiSessionChild,
  } = cliCtx;
  const profileConfigPath = activeProfileConfigPath(wpaths, config);

  // Attach the proxy probe's transition logger BEFORE anything can boot the
  // probe — `resolveModeAndCapabilities` below calls `bootstrapWrongProxy`,
  // which lazily starts the probe singleton; the very first activation (or
  // deactivation) must already land in wrongstack.log. Core's setter (not a
  // CLI-local one): the CLI bundle can duplicate proxy-probe.ts's module
  // scope across chunks, so the logger state MUST live in the externalized
  // core module to be shared by every bundled copy.
  setProxyTransitionLogger({ info: (m) => logger.info(m), warn: (m) => logger.warn(m) });

  const modeStore = container.resolve(TOKENS.ModeStore);
  const activeMode = await modeStore.getActiveMode();
  const modeResult = await resolveModeAndCapabilities({
    config,
    modelsRegistry,
    logger,
    activeMode,
  });
  if (modeResult.kind === 'exit') {
    writeErr(`${modeResult.message}\n`);
    await reader.close();
    return modeResult.code;
  }
  const { resolvedProvider, providerRegistry, provider, modeId, modePrompt, modelCapabilities } =
    modeResult;
  const modelCapabilitiesRef: { current: typeof modelCapabilities } = {
    current: modelCapabilities,
  };

  let memoryStore = container.resolve(TOKENS.MemoryStore);
  await memoryStore.initialize();

  // Disposer chain — collected up front so the vector-memory wiring
  // below can register its teardown (event-mirror dispose, store close)
  // alongside the rest. Run in LIFO order on shutdown.
  const teardownHandlers: Array<() => void> = [];

  const {
    memoryStore: vectorWrappedMemoryStore,
    vectorMemoryStore,
    vectorMemoryModelCacheDir,
  } = await setupVectorMemory({
    projectRoot,
    flags,
    logger,
    memoryStore,
    teardownHandlers,
  });
  memoryStore = vectorWrappedMemoryStore;

  const skillLoader = container.resolve(TOKENS.SkillLoader);
  const promptLoader = container.resolve(TOKENS.PromptLoader);
  const sessionRef: { current: import('@wrongstack/core/types').SessionWriter | undefined } = {
    current: undefined,
  };
  const autonomyModeRef: {
    current: import('./services/autonomy-mode.js').AutonomyMode;
  } = { current: 'off' };

  const { toolRegistry } = await setupCliPromptAndTools({
    container,
    modeStore,
    memoryStore,
    skillLoader,
    sessionRef,
    autonomyModeRef,
    modeId,
    modePrompt,
    modelCapabilitiesRef,
    config,
    wpaths,
    projectRoot,
    events,
    vectorMemoryStore,
  });

  const stdinInteractive = process.stdin.isTTY;
  const hookRunnerRef: {
    current: import('@wrongstack/core/tools').PluginManagerHookRunner | null;
  } = { current: null };
  const switchProviderAndModelRef: {
    current: ((providerId: string, modelId: string) => Promise<string | null>) | null;
  } = { current: null };
  registerCliManagementTools({
    toolRegistry,
    configStore,
    profileConfigPath,
    stdinInteractive,
    getHookRunner: () => hookRunnerRef.current,
    getSwitchProviderAndModel: () => switchProviderAndModelRef.current,
  });

  const { metricsSink, healthRegistry, metricsStatus } = setupMetrics({
    flags,
    wpaths,
    events,
    logger,
    config: { provider: config.provider, model: config.model },
  });

  const { tuiOwnsScreen, evOn } = setupTeardownRegistrar({
    flags,
    events,
    logger,
    teardownHandlers,
    vectorMemoryStore,
  });

  const eventWiring = wireEventWiring({
    evOn,
    events,
    renderer,
    getProvider: () => config.provider,
    getModel: () => config.model,
    getSessionId: () => sessionRef.current?.id ?? '',
    projectSlug: wpaths.projectSlug,
    getActiveModeId: () => activeMode?.id ?? 'off',
    tuiOwnsScreen,
  });

  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;
  const onlineAgents = await loadOnlineAgentsForPrompt(
    wpaths.projectDir,
    flags['simpleui'] === true,
  );

  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.listForProvider(),
    catalogTools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
  });

  const {
    sessionStore,
    tokenCounter,
    context,
    planPath,
    session,
    attachments,
    queueStore,
    detachTodosCheckpoint,
    priorFleetState,
    sessResult,
  } = await setupSessionEstablishment({
    container,
    config,
    wpaths,
    projectRoot,
    cwd,
    systemPrompt,
    provider,
    renderer,
    flags,
    events,
    logger,
    sessionRef,
    onlineAgents,
    tuiOwnsScreen,
  });

  const { governanceHandle } = await setupReplayAndGovernance({
    flags,
    container,
    wpaths,
    projectRoot,
    session,
    sessionRef,
    logger,
    events,
    planPath,
    sessionStore,
    context,
    traceId: sessResult.traceId,
    memoryStore,
  });

  const { tracker, activateSession } = await setupSessionRegistry({
    wpaths,
    projectRoot,
    session,
    context,
    tuiOwnsScreen,
    events,
  });

  const {
    errorRing,
    sessionBridge,
    stats,
    pipelines,
    refreshActiveReasoningConfig,
    getActiveReasoningConfig,
    disposeChronicle,
  } = setupSessionRuntime({
    evOn,
    events,
    config,
    context,
    session,
    sessionRef,
    wpaths,
    projectRoot,
    renderer,
    tuiOwnsScreen,
    tokenCounter,
    modelsRegistry,
    configStore,
    provider,
    logger,
    governanceHandle,
  });
  // Composition root owns process-level lifecycle hooks (chimera review:
  // reusable wiring modules must not install them).
  process.once('beforeExit', () => {
    void disposeChronicle();
  });

  const {
    autoCompactor,
    effectiveMaxContextRef,
    applyMaxContext,
    refreshMaxContext,
    agent,
    mcpRegistry,
    slashRegistry,
    hqPublisherRef,
    brainMailbox,
    pluginHost,
    hookRunner,
  } = await setupLifecycleAndPlugins({
    flags,
    config,
    container,
    pipelines,
    logger,
    session,
    events,
    modelsRegistry,
    context,
    provider,
    modelCapabilitiesRef,
    reader,
    wpaths,
    toolRegistry,
    providerRegistry,
    configStore,
    sessionBridge,
    eventWiring,
    healthRegistry,
    skillLoader,
    promptLoader,
    vault,
    metricsSink,
    metricsStatus,
    renderer,
    buildProviderForIdRuntime,
  });

  const { dwCfg } = setupDepWatcherBridge({
    config,
    wpaths,
    projectRoot,
    events,
    logger,
    teardownHandlers,
  });
  hookRunnerRef.current = hookRunner;

  const fallbackProfileManager = container.resolve(TOKENS.FallbackProfileManager);

  const statusTracker = await setupProviderStatus({
    events,
    paths: wpaths,
    fallbackProfileManager,
    logger,
    teardownHandlers,
  });
  // One waiting room per process. The runtime container binds a bare default
  // so a standalone webui-server boot has something to write into; the CLI's
  // instance is the real one — it carries the event bus (hence
  // `provider.status_changed` + disk persistence) and the entries restored
  // from the previous run. Without this override the container hands the
  // plugin one-shot orchestrator and `api.llm` a SECOND, empty tracker, so a
  // model quarantined by the agent loop stayed callable from those paths.
  container.override(TOKENS.ProviderModelStatusTracker, () => statusTracker);

  // Seed the WrongProxy / WrongTrace runtime singleton from persisted
  // config BEFORE the first provider is built. Without this, the WS prefs
  // pipeline is the only producer of `applyProxyConfig` and that path only
  // fires on incremental `prefs.update` messages — a CLI session that
  // boots with the toggle already on (and never sees a WebUI delta) runs
  // with the default `{ enabled: false, url: '', active: false }` and
  // `shouldRewriteFor()` returns false for every provider. `bootstrapWrongProxy`
  // is idempotent and lazily boots the probe when `enabled: true`.
  // `bootstrapWrongProxy` is idempotent and lazily boots the probe when
  // `enabled: true`. Its transition logger was attached at the top of
  // runInteractive — before this first bootstrap — so nothing is missed.
  bootstrapWrongProxy(config.tools?.wrongProxy);
  // Close the race against `setupProviderRuntime` below: the probe's first
  // poke() resolves on the next macrotask, but setupProviderRuntime reads
  // `getProxyConfig()` synchronously on the very next line. Awaiting the
  // probe here ensures `active` is correct before the singleton is read.
  await awaitFirstWrongProxyProbe();

  const { buildProviderForId, buildProviderForModel, switchProviderAndModel } =
    setupProviderRuntime({
      config,
      onConfigUpdate: (newConfig) => {
        config = newConfig;
      },
      configStore,
      fallbackProfileManager,
      providerRegistry,
      modelsRegistry,
      agent,
      memoryStore,
      refreshMaxContext,
      refreshActiveReasoningConfig,
      wpaths,
      vault,
      logger,
      teardownHandlers,
      context,
      events,
      resolveProviderCfgRuntime,
      buildProviderForIdRuntime,
      statusTracker,
    });
  switchProviderAndModelRef.current = switchProviderAndModel;

  await adoptResumedProvider({
    resumedProvider: sessResult.resumedProvider,
    resumedModel: sessResult.resumedModel,
    getConfig: () => config,
    switchProviderAndModel,
    logger,
  });

  registerProviderUtilityTools({
    toolRegistry,
    buildProvider: buildProviderForId,
    getConfig: () => config,
    fallbackProfileManager,
    statusTracker,
    wrapProviderCall: (request, inner) =>
      agent.extensions.wrapProviderRunner(
        (_ctx: typeof agent.ctx, wrappedRequest: import('@wrongstack/core/types').Request) =>
          inner(wrappedRequest),
        { exclude: ['fallback-model'] },
      )(agent.ctx, request),
    compactor: container.resolve(TOKENS.Compactor),
  });

  let {
    director,
    maxConcurrent,
    maxSpawns,
    maxConcurrentSource,
    maxSpawnsSource,
    autonomyMode,
    nextPredictEnabled,
    currentSuggestions,
    eternalEngine,
    parallelEngine,
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
  } = setupDirectorAndAutonomy({
    flags,
    config,
    wpaths,
    session,
    events,
    autonomyModeRef,
  });

  const { brain, brainLog, brainSettings, brainRuntime, multiAgentHost, shadowController } =
    setupBrainAndOrchestration({
      events,
      config,
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
      skillLoader: config.features.skills ? skillLoader : undefined,
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
    config,
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
    mcpRegistry,
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

  director = await ensureDirectorAndAnnounce({
    multiAgentHost,
    priorFleetState,
    renderer,
    toolRegistry,
    flags,
    fleetRoot,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
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
    agentsMonitorController,
    onPanelOpen,
    goalHost,
    coordinatorController,
    setYoloMode,
    secretInputController,
    sddRunRegistry,
  } = await setupCommandHostState({
    getConfig: () => config,
    setConfig: (nextConfig: typeof config) => {
      config = nextConfig;
    },
    getDirector: () => director,
    hqCommandController,
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
  });

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
    initialBrainLog: brainLog,
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
    getNextPredict: () => nextPredictEnabled,
    setNextPredict: (enabled) => {
      nextPredictEnabled = enabled;
    },
    getCurrentSuggestions: () => currentSuggestions,
    setCurrentSuggestions: (suggestions) => {
      currentSuggestions = suggestions;
    },
    teardownHandlers,
    pluginHost,
    logger,
    flags,
    errorRing,
    stats,
    broadcastEternalIteration,
    broadcastAutonomyStage,
    getAutonomyMode: () => autonomyMode,
    setAutonomyMode: (mode) => {
      autonomyMode = mode;
    },
    autonomyModeRef,
    getEternalEngine: () => eternalEngine,
    setEternalEngine: (engine) => {
      eternalEngine = engine;
    },
    getParallelEngine: () => parallelEngine,
    setParallelEngine: (engine) => {
      parallelEngine = engine;
    },
    sddRunRegistry,
    goalHost,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
  });

  const eternalFlag =
    typeof flags['eternal'] === 'string' ? (flags['eternal'] as string).trim() : '';
  const configRef = { current: config };
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
        return eternalEngine ?? undefined;
      },
      set current(engine) {
        eternalEngine = engine ?? null;
      },
    },
  });
  config = configRef.current;
  if (eternalFlag.length > 0) {
    autonomyMode = 'eternal';
  }

  const {
    runSageSessionHygiene,
    getPluginItems: getPluginPickerItems,
    togglePlugin: togglePluginFromPicker,
    getToolItems: getToolPickerItems,
  } = await prepareRuntimeDispatch({
    getConfig: () => config,
    setConfig: (nextConfig) => {
      config = nextConfig;
    },
    configStore,
    profileConfigPath,
    pipelines,
    memoryStore,
    logger,
    events,
    agent,
    context,
    projectRoot,
    toolRegistry,
    flags,
    onEvent: evOn,
  });

  const savedProviderCfg = config.providers?.[config.provider];

  setupCliHeapWatchdog({
    flags,
    tuiOwnsScreen,
    context,
    metricsSink,
    hqPublisherRef,
    brainMailbox,
    teardownHandlers,
  });

  return runCliExecution({
    agent,
    events,
    slashRegistry,
    tokenCounter,
    sessionRef,
    activateSession,
    config,
    configStore,
    wpaths,
    projectRoot,
    flags,
    positional,
    webuiSessionChild,
    updateInfo,
    attachments,
    brainMailbox,
    session,
    mcpRegistry,
    queueStore,
    context,
    detachTodosCheckpoint,
    sessResult,
    sessionStore,
    memoryStore,
    vectorMemoryStore,
    vectorMemoryModelCacheDir,
    modeStore,
    needsSetup,
    statusTracker,
    multiAgentHost,
    modelsRegistry,
    savedProviderCfg,
    resolvedProvider,
    logger,
    switchProviderAndModel,
    applyMaxContext,
    renderer,
    reader,
    secretInputController,
    effectiveMaxContextRef,
    stats,
    skillLoader,
    promptLoader,
    modeId,
    director,
    coordinatorController,
    fleetStreamController,
    agentTranscripts: agentMonitor,
    vault,
    profileConfigPath,
    onPanelOpen,
    interruptController,
    enhanceController,
    activeReasoningConfig: getActiveReasoningConfig(),
    configRef,
    buildProviderForModel,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    setYoloMode,
    autonomyMode,
    setAutonomyMode: (mode: typeof autonomyMode) => {
      autonomyMode = mode;
    },
    nextPredictEnabled,
    setNextPredict: (enabled: boolean) => {
      nextPredictEnabled = enabled;
    },
    container,
    sessionBridge,
    autoCompactor,
    getPluginPickerItems,
    togglePluginFromPicker,
    getToolPickerItems,
    brain,
    brainSettings,
    brainRuntime,
    brainLog,
    currentSuggestions,
    setCurrentSuggestions: (suggestions: typeof currentSuggestions) => {
      currentSuggestions = suggestions;
    },
    eternalEngine,
    parallelEngine,
    sddRunRegistry,
    eternalListeners,
    stageListeners,
    runSageSessionHygiene,
    pluginHost,
    teardownHandlers,
    governanceHandle,
    setConfig: (nextConfig: typeof config) => {
      config = nextConfig;
    },
  });
}
