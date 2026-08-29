import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import { gatedEnhancerReasoning } from '@wrongstack/core/execution';
import type { Container } from '@wrongstack/core/kernel';
import { TOKENS } from '@wrongstack/core/kernel';
import type { Logger } from '@wrongstack/core/types';
import { createAuthPanelHost } from '../auth-menu/panel-service.js';
import type { CliGovernanceRuntimeHandle } from '../cli-main-helpers.js';
import { createPickableProvidersLoader } from '../cli-main-helpers.js';
import type { MultiAgentHost } from '../fleet/host.js';
import { createRuntimeControllerDeps } from './runtime-controller-deps.js';
import { createRuntimeLifecycleDeps } from './runtime-lifecycle-deps.js';
import { createRuntimePickerDeps } from './runtime-picker-deps.js';
import { toExecuteDeps } from './to-execute-deps.js';

// Bag params are typed by their CONSUMER: every field flows into toExecuteDeps
// — directly or via one of the runtime deps factories — so each type is an
// indexed access of that destination. The aliases track the factories
// automatically when their params change.
type X = Parameters<typeof toExecuteDeps>[0];
type RC = Parameters<typeof createRuntimeControllerDeps>[0];
type RP = Parameters<typeof createRuntimePickerDeps>[0];
type RL = Parameters<typeof createRuntimeLifecycleDeps>[0];
type AUP = Parameters<typeof createAuthPanelHost>[0];

export async function runCliExecution(params: {
  agent: X['core']['agent'];
  events: X['core']['events'];
  slashRegistry: X['core']['slashRegistry'];
  tokenCounter: X['core']['tokenCounter'];
  sessionRef: NonNullable<X['core']['sessionRef']>;
  activateSession: X['core']['activateSessionIdentity'];
  config: X['core']['config'];
  configStore: X['core']['configStore'];
  wpaths: X['core']['wpaths'];
  projectRoot: string;
  flags: X['core']['flags'];
  positional: X['core']['positional'];
  webuiSessionChild: X['core']['webuiSessionChild'];
  updateInfo: X['core']['updateInfo'];
  attachments: X['session']['attachments'];
  brainMailbox: X['session']['mailbox'];
  session: X['session']['session'];
  mcpRegistry: X['session']['mcpRegistry'];
  queueStore: X['session']['queueStore'];
  context: X['session']['context'];
  detachTodosCheckpoint: X['session']['detachTodosCheckpoint'];
  sessResult: {
    rebindTodosCheckpoint: X['session']['rebindTodosCheckpoint'];
    restoredMessages: X['session']['restoredMessages'];
    restoredToolCalls: X['session']['restoredToolCalls'];
    restoredEvents: X['session']['restoredEvents'];
  };
  sessionStore: X['session']['sessionStore'];
  memoryStore: NonNullable<X['session']['memoryStore']>;
  vectorMemoryStore: X['session']['vectorMemoryStore'];
  vectorMemoryModelCacheDir: X['session']['vectorMemoryModelCacheDir'];
  modeStore: X['session']['modeStore'];
  needsSetup: X['session']['needsSetup'];
  statusTracker: X['provider']['statusTracker'];
  multiAgentHost: MultiAgentHost;
  modelsRegistry: X['provider']['modelsRegistry'];
  savedProviderCfg: X['provider']['savedProviderCfg'];
  resolvedProvider: X['provider']['resolvedProvider'];
  logger: Logger;
  switchProviderAndModel: X['provider']['switchProviderAndModel'];
  applyMaxContext: NonNullable<X['provider']['onModelContextResolved']>;
  renderer: X['ui']['renderer'];
  reader: X['ui']['reader'];
  secretInputController: X['ui']['secretInputController'];
  effectiveMaxContextRef: { readonly current: X['ui']['effectiveMaxContext'] };
  stats: X['ui']['stats'];
  skillLoader: X['ui']['skillLoader'];
  promptLoader: X['ui']['promptLoader'];
  modeId: X['ui']['modeId'];
  director: X['fleet']['director'];
  coordinatorController: X['fleet']['coordinatorController'];
  fleetStreamController: X['fleet']['fleetStreamController'];
  agentTranscripts?: X['fleet']['agentTranscripts'];
  agentMonitor?: X['fleet']['agentTranscripts'];
  vault: AUP['vault'];
  profileConfigPath: string;
  onPanelOpen: X['fleet']['onPanelOpen'];
  interruptController: RC['interruptController'];
  enhanceController: RC['enhanceController'];
  activeReasoningConfig: Parameters<typeof gatedEnhancerReasoning>[0];
  configRef: { current: X['core']['config'] };
  buildProviderForModel: RC['buildProviderForModel'];
  statuslineHiddenItems: RC['statuslineHiddenItems'];
  setStatuslineHiddenItems: NonNullable<RC['setStatuslineHiddenItems']>;
  saveStatuslineHiddenItems: NonNullable<RC['saveStatuslineHiddenItems']>;
  statuslineLines?: RC['statuslineLines'];
  setStatuslineLines?: NonNullable<RC['setStatuslineLines']>;
  saveStatuslineLines?: NonNullable<RC['saveStatuslineLines']>;
  setYoloMode: NonNullable<RC['getYolo']>;
  autonomyMode: ReturnType<RC['getAutonomy']>;
  setAutonomyMode: NonNullable<RC['setAutonomy']>;
  nextPredictEnabled: ReturnType<RC['getNextPredict']>;
  setNextPredict: NonNullable<RC['setNextPredict']>;
  container: Container;
  sessionBridge: RC['sessionBridge'];
  autoCompactor: RC['autoCompactor'];
  getPluginPickerItems: RP['getPluginItems'];
  togglePluginFromPicker: RP['togglePlugin'];
  getToolPickerItems: RP['getToolItems'];
  brain: RP['brain'];
  brainSettings: RP['brainSettings'];
  brainRuntime: RP['brainRuntime'];
  brainLog: ReturnType<NonNullable<RP['getBrainLog']>>;
  currentSuggestions: ReturnType<RL['getCurrentSuggestions']>;
  setCurrentSuggestions: RL['setCurrentSuggestions'];
  eternalEngine: ReturnType<RL['getEternalEngine']>;
  parallelEngine: ReturnType<RL['getParallelEngine']>;
  sddRunRegistry: RL['sddRunRegistry'];
  eternalListeners: RL['eternalListeners'];
  stageListeners: RL['stageListeners'];
  runSageSessionHygiene: RL['runSageSessionHygiene'];
  pluginHost: RL['pluginHost'];
  teardownHandlers: RL['teardownHandlers'];
  governanceHandle: CliGovernanceRuntimeHandle | undefined;
  setConfig: RC['setConfig'];
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
    statuslineLines,
    setStatuslineLines,
    saveStatuslineLines,
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
        releaseSessionHelpers: (sessionId: string) => multiAgentHost.releaseSession(sessionId),
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
        getActiveModelReasoningEffortLevels: () => {
          const rc = activeReasoningConfig;
          return rc?.effortSupported && rc.effortLevels?.length ? [...rc.effortLevels] : undefined;
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
        statuslineLines,
        setStatuslineLines,
        saveStatuslineLines,
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
          // The policy decides YOLO per conversation and only falls back to
          // its process flag, so the live context has to move with it.
          agent.ctx.meta['yolo'] = enabled;
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
        // cli-main attaches toolRegistry onto the Context object dynamically
        // (core Context does not declare it). The previous `?? agent.ctx.tools`
        // fallback was a latent crash: ctx.tools is a Tool[], which cannot
        // satisfy the ToolRegistry the picker calls into.
        toolRegistry: (params.context as unknown as { toolRegistry: RP['toolRegistry'] })
          .toolRegistry,
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
