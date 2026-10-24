/**
 * Phase 1 of {@link runInteractive} (cli-main.ts): mode + provider resolution,
 * memory, initial tools, session establishment, governance, session runtime,
 * lifecycle/plugins and the provider runtime.
 */

import { TOKENS } from '@wrongstack/contracts/kernel';
import { createEventUserInputAwaiter, isUnattendedAutonomy } from '@wrongstack/core/agent';
import { flagsToConfigPatch } from '@wrongstack/core/boot';
import { DefaultConfigLoader } from '@wrongstack/core/storage';
import { writeErr } from '@wrongstack/core/utils';
import { setProxyTransitionLogger } from '@wrongstack/core/wiring/proxy-rewrite';
import { resolveModeAndCapabilities } from './boot/system-prompt.js';
import type { CliContext } from './cli-context.js';
import { setupInitialCliTools } from './cli-initial-tools.js';
import type { CliConfigState } from './cli-main-state.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { setupDepWatcherBridge } from './wiring/dep-watcher-bridge.js';
import { setupLifecycleAndPlugins } from './wiring/lifecycle-plugins.js';
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
import { awaitFirstWrongProxyProbe, bootstrapWrongProxy } from './wiring/proxy-wiring.js';
import { setupReplayAndGovernance } from './wiring/replay-governance-setup.js';
import { setupSessionEstablishment } from './wiring/session-establishment.js';
import { setupSessionRegistry } from './wiring/session-registry.js';
import { setupSessionRuntime } from './wiring/session-runtime.js';
import { setupVectorMemory } from './wiring/vector-memory-setup.js';

export async function bootCliRuntime(cliCtx: CliContext, state: CliConfigState) {
  const {
    vault,
    wpaths,
    cwd,
    projectRoot,
    flags,
    modelsRegistry,
    renderer,
    reader,
    logger,
    events,
    container,
    configStore,
  } = cliCtx;
  const profileConfigPath = activeProfileConfigPath(wpaths, state.config);

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
    config: state.config,
    modelsRegistry,
    logger,
    activeMode,
  });
  if (modeResult.kind === 'exit') {
    writeErr(`${modeResult.message}\n`);
    await reader.close();
    return { kind: 'exit' as const, code: modeResult.code };
  }
  const { resolvedProvider, providerRegistry, provider, modeId, modePrompt, modelCapabilities } =
    modeResult;
  const { providerAuthRegistry } = modeResult;
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
    tuning: state.config.Sage?.vector,
  });
  memoryStore = vectorWrappedMemoryStore;
  const {
    skillLoader,
    promptLoader,
    sessionRef,
    autonomyModeRef,
    toolRegistry,
    hookRunnerRef,
    switchProviderAndModelRef,
    metricsSink,
    healthRegistry,
    metricsStatus,
    tracer,
    tuiOwnsScreen,
    evOn,
    eventWiring,
    promptBuilder,
    onlineAgents,
    systemPrompt,
  } = await setupInitialCliTools({
    container,
    flags,
    renderer,
    modeStore,
    memoryStore,
    modeId,
    modePrompt,
    modelCapabilitiesRef,
    getConfig: () => state.config,
    wpaths,
    projectRoot,
    events,
    vectorMemoryStore,
    configStore,
    profileConfigPath,
    modelsRegistry,
    logger,
    teardownHandlers,
    activeMode,
    cwd,
    provider,
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
    config: state.config,
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
  // A form nobody answers during eternal / parallel autonomy gets no answer
  // after the approval wait instead of holding the run; WebUI tabs share it.
  context.userInputAwaiter ??= createEventUserInputAwaiter(events, {
    isUnattended: (meta) => isUnattendedAutonomy(meta?.['autonomy'], autonomyModeRef.current),
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
    config: state.config,
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
    tracer,
    flags,
    config: state.config,
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
    providerAuthRegistry,
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
    config: state.config,
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
  bootstrapWrongProxy(state.config.tools?.wrongProxy);
  // Close the race against `setupProviderRuntime` below: the probe's first
  // poke() resolves on the next macrotask, but setupProviderRuntime reads
  // `getProxyConfig()` synchronously on the very next line. Awaiting the
  // probe here ensures `active` is correct before the singleton is read.
  await awaitFirstWrongProxyProbe();

  const liveConfigLoader = new DefaultConfigLoader({ paths: wpaths, vault, logger });
  const {
    buildProviderForId,
    buildProviderForModel,
    switchProviderAndModel,
    reloadProviderConfig,
  } = setupProviderRuntime({
    config: state.config,
    loadConfig: () =>
      liveConfigLoader.load({
        cliFlags: flagsToConfigPatch(cliCtx.flags),
        skipIdentityValidation: true,
      }),
    onConfigUpdate: (newConfig) => {
      state.config = newConfig;
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
    getConfig: () => state.config,
    switchProviderAndModel,
    logger,
  });

  registerProviderUtilityTools({
    toolRegistry,
    buildProvider: buildProviderForId,
    getConfig: () => state.config,
    fallbackProfileManager,
    statusTracker,
    wrapProviderCall: (request, inner) =>
      agent.extensions.wrapProviderRunner(
        (_ctx: typeof agent.ctx, wrappedRequest: import('@wrongstack/contracts/types').Request) =>
          inner(wrappedRequest),
        { exclude: ['fallback-model'] },
      )(agent.ctx, request),
    compactor: container.resolve(TOKENS.Compactor),
    modelsRegistry,
  });

  return {
    kind: 'ready' as const,
    activateSession,
    agent,
    applyMaxContext,
    attachments,
    autoCompactor,
    autonomyModeRef,
    brainMailbox,
    buildProviderForId,
    buildProviderForModel,
    context,
    detachTodosCheckpoint,
    dwCfg,
    effectiveMaxContextRef,
    errorRing,
    evOn,
    eventWiring,
    getActiveReasoningConfig,
    governanceHandle,
    healthRegistry,
    hqPublisherRef,
    mcpRegistry,
    memoryStore,
    metricsSink,
    metricsStatus,
    modeId,
    modeStore,
    pipelines,
    planPath,
    pluginHost,
    priorFleetState,
    profileConfigPath,
    promptBuilder,
    promptLoader,
    provider,
    providerAuthRegistry,
    providerRegistry,
    queueStore,
    reloadProviderConfig,
    resolvedProvider,
    sessResult,
    session,
    sessionBridge,
    sessionRef,
    sessionStore,
    skillLoader,
    slashRegistry,
    stats,
    statusTracker,
    switchProviderAndModel,
    teardownHandlers,
    tokenCounter,
    toolRegistry,
    tracer,
    tracker,
    tuiOwnsScreen,
    vectorMemoryModelCacheDir,
    vectorMemoryStore,
  };
}

export type CliBootResult = Extract<Awaited<ReturnType<typeof bootCliRuntime>>, { kind: 'ready' }>;
