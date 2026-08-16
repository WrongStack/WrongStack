import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import { gatedEnhancerReasoning } from '@wrongstack/core/execution';
import { TOKENS } from '@wrongstack/core/kernel';
import { createAuthPanelHost } from '../auth-menu/panel-service.js';
import { createPickableProvidersLoader } from '../cli-main-helpers.js';
import { createRuntimeControllerDeps } from './runtime-controller-deps.js';
import { createRuntimeLifecycleDeps } from './runtime-lifecycle-deps.js';
import { createRuntimePickerDeps } from './runtime-picker-deps.js';
import { toExecuteDeps } from './to-execute-deps.js';

export async function runCliExecution(params: {
  agent: any;
  events: any;
  slashRegistry: any;
  tokenCounter: any;
  sessionRef: any;
  activateSession: any;
  config: any;
  configStore: any;
  wpaths: any;
  projectRoot: string;
  flags: any;
  positional: any;
  webuiSessionChild: any;
  updateInfo: any;
  attachments: any;
  brainMailbox: any;
  session: any;
  mcpRegistry: any;
  queueStore: any;
  context: any;
  detachTodosCheckpoint: any;
  sessResult: any;
  sessionStore: any;
  memoryStore: any;
  vectorMemoryStore: any;
  vectorMemoryModelCacheDir: any;
  modeStore: any;
  needsSetup: any;
  statusTracker: any;
  multiAgentHost: any;
  modelsRegistry: any;
  savedProviderCfg: any;
  resolvedProvider: any;
  logger: any;
  switchProviderAndModel: any;
  applyMaxContext: any;
  renderer: any;
  reader: any;
  secretInputController: any;
  effectiveMaxContextRef: any;
  stats: any;
  skillLoader: any;
  promptLoader: any;
  modeId: any;
  director: any;
  coordinatorController: any;
  fleetStreamController: any;
  agentTranscripts?: any;
  agentMonitor?: any;
  vault: any;
  profileConfigPath: string;
  onPanelOpen: any;
  interruptController: any;
  enhanceController: any;
  activeReasoningConfig: any;
  configRef: any;
  buildProviderForModel: any;
  statuslineHiddenItems: any;
  setStatuslineHiddenItems: any;
  saveStatuslineHiddenItems: any;
  setYoloMode: any;
  autonomyMode: any;
  setAutonomyMode: any;
  nextPredictEnabled: any;
  setNextPredict: any;
  container: any;
  sessionBridge: any;
  autoCompactor: any;
  getPluginPickerItems: any;
  togglePluginFromPicker: any;
  getToolPickerItems: any;
  brain: any;
  brainSettings: any;
  brainRuntime: any;
  brainLog: any;
  currentSuggestions: any;
  setCurrentSuggestions: any;
  eternalEngine: any;
  parallelEngine: any;
  sddRunRegistry: any;
  eternalListeners: any;
  stageListeners: any;
  runSageSessionHygiene: any;
  pluginHost: any;
  teardownHandlers: any;
  governanceHandle: any;
  setConfig: (cfg: any) => void;
}): Promise<number> {
  const {
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
    agentTranscripts,
    agentMonitor,
    vault,
    profileConfigPath,
    onPanelOpen,
    interruptController,
    enhanceController,
    activeReasoningConfig,
    configRef,
    buildProviderForModel,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    setYoloMode,
    autonomyMode,
    setAutonomyMode,
    nextPredictEnabled,
    setNextPredict,
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
    setCurrentSuggestions,
    eternalEngine,
    parallelEngine,
    sddRunRegistry,
    eternalListeners,
    stageListeners,
    runSageSessionHygiene,
    pluginHost,
    teardownHandlers,
    governanceHandle,
    setConfig,
  } = params;

  const { execute } = await import('../execution.js');

  return execute(
    toExecuteDeps({
      core: {
        agent,
        events,
        slashRegistry,
        tokenCounter,
        sessionRef,
        activateSessionIdentity: activateSession,
        config,
        configStore,
        wpaths,
        projectRoot,
        flags,
        positional,
        webuiSessionChild,
        updateInfo,
      },
      session: {
        attachments,
        mailbox: brainMailbox,
        session,
        mcpRegistry,
        queueStore,
        context,
        detachTodosCheckpoint,
        rebindTodosCheckpoint: sessResult.rebindTodosCheckpoint,
        sessionStore,
        memoryStore,
        vectorMemoryStore,
        vectorMemoryModelCacheDir,
        modeStore,
        restoredMessages: sessResult.restoredMessages,
        restoredToolCalls: sessResult.restoredToolCalls,
        restoredEvents: sessResult.restoredEvents,
        needsSetup,
      },
      provider: {
        statusTracker,
        sddSubagentFactory: multiAgentHost.makeSubagentFactory(config),
        modelsRegistry,
        savedProviderCfg: savedProviderCfg as
          | import('@wrongstack/core/types').ProviderConfig
          | undefined,
        resolvedProvider: resolvedProvider ?? undefined,
        getPickableProviders: createPickableProvidersLoader({
          modelsRegistry,
          logger,
          getConfig: () => config,
        }),
        switchProviderAndModel,
        onModelContextResolved: (providerId, modelId, maxContext) => {
          applyMaxContext(providerId, modelId, maxContext);
        },
      },
      ui: {
        renderer,
        reader,
        secretInputController,
        effectiveMaxContext: effectiveMaxContextRef.current,
        getEffectiveMaxContext: () => effectiveMaxContextRef.current,
        stats,
        skillLoader: config.features.skills ? skillLoader : undefined,
        promptLoader: config.features.prompts === false ? undefined : promptLoader,
        modeId,
      },
      fleet: {
        director: director ?? null,
        getDirector: () => director,
        coordinatorController,
        fleetRoster: FLEET_ROSTER as Record<string, { name: string }>,
        fleetStreamController,
        agentTranscripts: agentTranscripts ?? agentMonitor,
        authHost: createAuthPanelHost({
          vault,
          modelsRegistry,
          profileConfigPath,
        }),
        onPanelOpen,
      },
      controllers: createRuntimeControllerDeps({
        interruptController,
        enhanceController,
        getEnhancerReasoning: async (providerId = context.provider.id, modelId = context.model) => {
          if (providerId === context.provider.id && modelId === context.model) {
            return gatedEnhancerReasoning(activeReasoningConfig);
          }
          try {
            const direct = await modelsRegistry.getModel(providerId, modelId);
            if (direct) return gatedEnhancerReasoning(direct.capabilities.reasoningConfig);
            const providerType = configRef.current.providers?.[providerId]?.type;
            if (providerType && providerType !== providerId) {
              const typed = await modelsRegistry.getModel(providerType, modelId);
              return gatedEnhancerReasoning(typed?.capabilities.reasoningConfig);
            }
          } catch {
            // Unknown/custom model: omit the optional reasoning field.
          }
          return undefined;
        },
        buildProviderForModel,
        context,
        getConfig: () => configRef.current,
        setConfig: (nextConfig) => {
          setConfig(nextConfig);
          configRef.current = nextConfig;
        },
        statuslineHiddenItems,
        setStatuslineHiddenItems,
        saveStatuslineHiddenItems,
        getYolo: setYoloMode,
        onYolo: setYoloMode,
        getAutonomy: () => autonomyMode,
        setAutonomy: (mode) => {
          setAutonomyMode(mode);
        },
        getNextPredict: () => nextPredictEnabled,
        setNextPredict: (enabled) => {
          setNextPredict(enabled);
        },
        agent,
        setPermissionYolo: (enabled) => {
          container.resolve(TOKENS.PermissionPolicy).setYolo?.(enabled);
        },
        setLogLevel: (level) => {
          container.resolve(TOKENS.Logger).level = level;
        },
        sessionBridge,
        autoCompactor,
        multiAgentHost,
        events,
        getSessionId: () => sessionRef.current?.id ?? session.id,
      }),
      picker: createRuntimePickerDeps({
        getConfig: () => config,
        setConfig,
        profileConfigPath,
        mcpRegistry,
        toolRegistry: params.context.toolRegistry ?? params.agent.ctx.tools,
        configStore,
        getPluginItems: getPluginPickerItems,
        togglePlugin: togglePluginFromPicker,
        getToolItems: getToolPickerItems,
        brain,
        brainSettings,
        brainRuntime,
        getBrainLog: () => brainLog,
      }),
      lifecycles: createRuntimeLifecycleDeps({
        getConfig: () => config,
        context,
        getCurrentSuggestions: () => currentSuggestions,
        setCurrentSuggestions: (suggestions) => {
          setCurrentSuggestions(suggestions);
        },
        getEternalEngine: () => eternalEngine,
        getParallelEngine: () => parallelEngine,
        sddRunRegistry,
        projectRoot,
        paths: {
          projectSpecs: wpaths.projectSpecs,
          projectTaskGraphs: wpaths.projectTaskGraphs,
          projectSddSession: wpaths.projectSddSession,
          projectSddBoards: wpaths.projectSddBoards,
        },
        eternalListeners,
        stageListeners,
        runSageSessionHygiene,
        pluginHost,
        teardownHandlers,
        stats,
        events,
        logger,
      }),
    }),
  ).finally(async () => {
    const governanceCleanup = await governanceHandle?.close();
    if (governanceCleanup && !governanceCleanup.ok) {
      logger.warn(`governance: ${governanceCleanup.action} cleanup failed`, {
        message: governanceCleanup.message,
      });
    }
    memoryStore.dispose();
  });
}
