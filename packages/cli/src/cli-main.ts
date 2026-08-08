/** Top-level CLI phase orchestrator. */
import * as path from 'node:path';
import { FLEET_ROSTER, mailboxSessionTag } from '@wrongstack/core/coordination';
import { gatedEnhancerReasoning } from '@wrongstack/core/execution';
import { TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { getSessionRegistry } from '@wrongstack/core/storage';
import type { SystemPromptBuilder } from '@wrongstack/core/types';
import { startSharedHeapWatchdog, writeErr } from '@wrongstack/core/utils';
import { createAuthPanelHost } from './auth-menu/panel-service.js';
import { wireEventWiring } from './boot/event-wiring.js';
import { configureSimpleUiRuntimeContext } from './boot/simpleui-full-auto.js';
import { resolveModeAndCapabilities } from './boot/system-prompt.js';
import { bindSystemPromptBuilder } from './boot/system-prompt-builder.js';
import { registerBuiltinTools } from './boot/tool-registry.js';
import type { CliContext } from './cli-context.js';
import { launchEternalFromFlag } from './cli-eternal-flag.js';
import {
  createPickableProvidersLoader,
  createTeardownEventRegistrar,
  getSddRuntimeStateForCli,
  loadOnlineAgentsForPrompt,
  setupCliGovernance,
} from './cli-main-helpers.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { wireSessionEvents } from './session-event-wiring.js';
import { SessionStats } from './session-stats.js';
import { CLI_VERSION } from './version.js';
import { setupBrainAndOrchestration } from './wiring/brain-and-orchestration.js';
import { createCommandHostAdapters } from './wiring/command-host-adapters.js';
import { setupCommandHostState } from './wiring/command-host-state.js';
import { setupDepWatcherConsumers } from './wiring/dep-watcher.js';
import { setupDepWatcherBridge } from './wiring/dep-watcher-bridge.js';
import { setupDirectorAndAutonomy } from './wiring/director-setup.js';
import { createEternalCommandHandlers } from './wiring/eternal-command-handlers.js';
import { createFleetCommandHandlers } from './wiring/fleet-command-handlers.js';
import { setupHqTelemetry } from './wiring/hq-telemetry.js';
import { setupLifecycleAndPlugins } from './wiring/lifecycle-plugins.js';
import { registerCliManagementTools } from './wiring/management-tools.js';
import { setupMetrics } from './wiring/metrics.js';
import { setupPipelines } from './wiring/pipeline.js';
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
import { createRuntimeControllerDeps } from './wiring/runtime-controller-deps.js';
import { prepareRuntimeDispatch } from './wiring/runtime-dispatch-state.js';
import { createRuntimeLifecycleDeps } from './wiring/runtime-lifecycle-deps.js';
import { createRuntimePickerDeps } from './wiring/runtime-picker-deps.js';
import { createSddHandlers } from './wiring/sdd-handlers.js';
import { setupSession } from './wiring/session.js';
import { createSessionCommandHandlers } from './wiring/session-command-handlers.js';
import { setupSessionRegistry } from './wiring/session-registry.js';
import { buildCommandHostSlashCommands } from './wiring/slash-commands.js';
import { toExecuteDeps } from './wiring/to-execute-deps.js';

export { CLI_VERSION };

/**
 * Everything the CLI needs once it knows it is running an interactive session.
 *
 * The boundary that keeps the ~30 wiring modules imported above — and
 * `@wrongstack/sdd`, `/acp`, `/sage`, `/mcp`, `/security-scanner` behind them
 * — out of the graph that every `wstack` invocation loads is the
 * `await import('./cli-main.js')` in `cli-entry-main.ts:33`. Because
 * `@wrongstack/cli` is built with `splitting: true` (see
 * `scripts/build-package.mjs`), that dynamic import makes the whole module
 * graph behind this file a deferred chunk, so subcommands like `wstack
 * version` and `wstack mailbox serve` never pay for it at boot.
 *
 * A secondary boundary lives inside this function at the
 * `await import('./execution.js')` further below — it defers the dispatch
 * layer (slash commands, UI controllers) until after the wiring/agent
 * setup is complete, keeping the post-setup chunk focused on dispatch.
 * See `cli-entry-main.ts` for the full rationale and the bundling
 * constraint that makes the outer boundary real.
 *
 * This function is intentionally exported: `cli-entry-main.ts` consumes it
 * via `await import('./cli-main.js')`, and that dynamic import requires
 * the binding to be a real ESM export. There is no in-tree static caller.
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

  const memoryStore = container.resolve(TOKENS.MemoryStore);
  await memoryStore.initialize();
  const skillLoader = container.resolve(TOKENS.SkillLoader);
  const promptLoader = container.resolve(TOKENS.PromptLoader);
  const sessionRef: { current: import('@wrongstack/core/types').SessionWriter | undefined } = {
    current: undefined,
  };
  // Forward declaration: the autonomy mode state lives later in this
  // function but the SystemPromptBuilder needs a reference to it NOW so
  // the autonomy contributor can read the current mode at build time.
  // Mutated by `onAutonomy` / `onEternalStart` below — the contributor
  // reads it on every system-prompt build (per turn).
  const autonomyModeRef: {
    current: import('./services/autonomy-mode.js').AutonomyMode;
  } = { current: 'off' };
  bindSystemPromptBuilder({
    container,
    modeStore,
    memoryStore,
    skillLoader,
    sessionRef,
    autonomyModeRef,
    modeId,
    modePrompt,
    modelCapabilities: () => modelCapabilitiesRef.current,
    skillsEnabled: config.features.skills,
    skillMode: config.skills?.mode,
    skillEagerMaxChars: config.skills?.eagerMaxChars,
    tokenSavingMode: config.features.tokenSavingMode,
    systemPromptVariant: config.systemPrompt?.variant,
    paths: {
      projectGoal: wpaths.projectGoal,
      projectSessions: wpaths.projectSessions,
      globalInstructions: wpaths.globalInstructions,
      inProjectInstructions: wpaths.inProjectInstructions,
    },
    pathJoiner: { join: (a, b) => path.join(a, b) },
    systemPromptBuilderToken: TOKENS.SystemPromptBuilder,
  });

  const toolRegistry = new ToolRegistry();
  registerBuiltinTools({
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    config,
    memoryStore,
    events,
    wpaths,
  });

  // Register fallback/provider/model management tools (LLM-accessible).
  // These tools read config from the in-memory store and persist changes
  // to the active profile config file, mirroring updates back to the store.
  const stdinInteractive = process.stdin.isTTY;
  // The hook runner is created by setupLifecycleAndPlugins further down, so
  // plugin_manager gets a ref-backed getter that starts null and is filled
  // once wiring completes. Until then the nested `use` path simply runs
  // without hooks — the same window in which no tool call runs at all.
  const hookRunnerRef: {
    current: import('@wrongstack/core/tools').PluginManagerHookRunner | null;
  } = { current: null };
  registerCliManagementTools({
    toolRegistry,
    configStore,
    profileConfigPath,
    stdinInteractive,
    getHookRunner: () => hookRunnerRef.current,
  });

  // Metrics wiring — extracted to wiring/metrics.ts
  const { metricsSink, healthRegistry, metricsStatus } = (() => {
    const ms = setupMetrics({
      flags,
      wpaths,
      events,
      logger,
      config: { provider: config.provider, model: config.model },
    });
    return ms;
  })();

  // True when the Ink TUI owns the screen. The TUI renders its own status,
  // streaming, and delegate lines, so the REPL-presentation handlers below
  // (spinner + inline streaming + retry/error lines) must stand down to avoid
  // fighting Ink's cursor math.
  const tuiOwnsScreen = flags.tui === true && flags['no-tui'] !== true;

  // Collect unsubscriber handles so we can detach on process exit. In the
  // default single-shot flow the process exits right after agent.run(), but
  // REPL/TUI modes keep the EventBus alive across multiple runs — stale
  // handlers from a re-entrant main() would otherwise accumulate.
  const teardownHandlers: Array<() => void> = [];
  const evOn = createTeardownEventRegistrar(events, teardownHandlers);

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

  // Provider instance — registry-driven by default, but falls through to
  // Build system prompt
  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;

  // Fetch online agents from the shared mailbox to include in system prompt.
  // HQ telemetry is owned by setupHqTelemetry below; opening a publisher here
  // created a second client for the same process with no live session bridge.
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

  const sessionStore = container.resolve(TOKENS.SessionStore);
  const tokenCounter = container.resolve(TOKENS.TokenCounter);
  tokenCounter.setSessionId?.(() => sessionRef.current?.id);
  const sessionRegistry = getSessionRegistry(wpaths.globalRoot);
  const sessResult = await setupSession({
    config: { model: config.model, provider: config.provider },
    wpaths,
    projectRoot,
    cwd,
    sessionStore,
    systemPrompt,
    provider,
    tokenCounter,
    renderer,
    flags,
    events,
    logger,
    claimSession: async (sessionId) => {
      await sessionRegistry.register({
        sessionId,
        projectSlug: wpaths.projectSlug,
        projectRoot,
        projectName: path.basename(projectRoot),
        workingDir: cwd,
        clientType: flags.webui || flags.simpleui ? 'webui' : tuiOwnsScreen ? 'tui' : 'cli',
        pid: process.pid,
        startedAt: new Date().toISOString(),
      });
      return async () => sessionRegistry.unregister();
    },
  });
  const { context, planPath, session } = sessResult;
  sessionRef.current = session;
  const governanceHandle = await setupCliGovernance({
    projectRoot,
    projectId: wpaths.projectSlug,
    sessionId: session.id,
    contextMeta: context.meta,
    logger,
    events,
    planPath,
    captureWorkspaceCheckpoint: async () =>
      sessionStore.captureWorkspaceCheckpoint?.(session.id, 0),
  });
  configureSimpleUiRuntimeContext(context.meta, flags);
  const { attachments, queueStore } = sessResult;
  const detachTodosCheckpoint = sessResult.detachTodosCheckpoint;
  const priorFleetState = sessResult.priorFleetState;

  // Attach the session trace ID to the memory store so all `storage.*` events
  // from `remember`/`forget`/`consolidate` calls during this session carry
  // the root trace ID for observability correlation.  The store is a singleton;
  // mutating it in-place means all consumers (tools, SessionMemoryConsolidator,
  // slash commands) automatically get the decorated store without rebinding.
  memoryStore.withTraceId(sessResult.traceId);

  // ── SessionRegistry + AgentStatusTracker ──────────────────────────
  // Register this session in the cross-process registry so /sessions status
  // and the WebUI can discover it. Start the agent status tracker that
  // listens to EventBus events and pushes live status to the registry.
  // Failures degrade gracefully — tracker stays undefined and downstream
  // code treats an absent tracker as a no-op.
  const { tracker, activateSession } = await setupSessionRegistry({
    wpaths,
    projectRoot,
    session,
    context,
    tuiOwnsScreen,
    events,
  });

  // SessionEventBridge + audit events (extracted to session-event-wiring.ts).
  const { errorRing, sessionBridge, disposeChronicle } = wireSessionEvents({
    evOn,
    events,
    config: config as unknown as Record<string, unknown>,
    context: context as unknown as Record<string, unknown>,
    session,
    sessionRef,
    wpaths,
    projectRoot,
    renderer,
    tuiOwnsScreen,
  });
  process.once('beforeExit', () => {
    void disposeChronicle();
  });

  const stats = new SessionStats(events, tokenCounter);

  // Live view of the active model's reasoning capabilities. Refreshed whenever
  // the provider/model changes so the model-runtime middleware can gate
  // reasoning/effort settings on what the model actually accepts.
  let activeReasoningConfig: import('@wrongstack/core/types').ReasoningConfig | undefined;
  // Suppressed-setting warnings repeat on every request (the resolver runs in
  // the request pipeline); log each distinct message once per model. The set
  // resets on model change so a new model's incompatibilities still surface,
  // and a changed effort value produces a new message text so it re-warns.
  const warnedRuntimeMessages = new Set<string>();
  const refreshActiveReasoningConfig = async (providerId: string, modelId: string) => {
    warnedRuntimeMessages.clear();
    try {
      const resolved = await modelsRegistry.getModel(providerId, modelId);
      activeReasoningConfig = resolved?.capabilities.reasoningConfig;
    } catch {
      activeReasoningConfig = undefined;
    }
  };
  void refreshActiveReasoningConfig(config.provider, config.model);

  const pipelines = setupPipelines({
    events,
    logger,
    modelRuntime: {
      getSettings: () => configStore.get().modelRuntime,
      getReasoningConfig: () => activeReasoningConfig,
      getCapabilities: () => provider.capabilities,
      onWarning: (message) => {
        if (warnedRuntimeMessages.has(message)) return;
        warnedRuntimeMessages.add(message);
        logger.warn(`model-runtime: ${message}`);
      },
    },
  });
  governanceHandle?.installToolBoundary(pipelines);

  // ── Lifecycle hooks → compaction → agent → MCP → plugins ─────────────
  // Extracted to wiring/lifecycle-plugins.ts.
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

  // ── Dep-watcher bridge: wire file-watcher events into the mailbox ────
  // Parses config and activates the bridge when enabled. Returns dwCfg
  // so it can be passed to setupDepWatcherConsumers without re-parsing.
  const { dwCfg } = setupDepWatcherBridge({
    config,
    wpaths,
    projectRoot,
    events,
    logger,
    teardownHandlers,
  });
  // Now that the hook pipeline exists, expose it to plugin_manager's nested
  // `use` path (registered above, before hooks could exist).
  hookRunnerRef.current = hookRunner;

  // ── Provider runtime helpers + fallback + switch + credential watcher ──
  // Extracted to wiring/provider-runtime-setup.ts.
  const fallbackProfileManager = container.resolve(TOKENS.FallbackProfileManager);

  // ── Provider/Model Status Tracker (shared singleton) ──────────────────
  // Created BEFORE the provider runtime so every component that touches
  // providers gets the same instance. Bound to the FallbackProfileManager
  // immediately so fallback chains filter blocked models even before the
  // first agent run.
  const statusTracker = await setupProviderStatus({
    events,
    paths: wpaths,
    fallbackProfileManager,
    logger,
    teardownHandlers,
  });

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

  // ── Boot resume: adopt the resumed session's own model/provider ──────────
  // Parity with the in-session resume picker (tui-session-resume.ts): a fresh
  // `wstack --resume <id>` continues on the model the session was recorded
  // with rather than the current default. Fully guarded — switchProviderAndModel
  // try/catches and returns an error string (never throws), and leaves the
  // current provider/model intact when the recorded provider is no longer
  // configured, so an unavailable provider gracefully falls back to the default.
  await adoptResumedProvider({
    resumedProvider: sessResult.resumedProvider,
    resumedModel: sessResult.resumedModel,
    getConfig: () => config,
    switchProviderAndModel,
    logger,
  });

  // Register the `llm` tool — one-shot LLM invocations with provider
  // resolution and fallback chain. buildProviderForId is now available.
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
        // OneShotOrchestrator owns the selected provider and fallback chain.
        // The agent-loop fallback wrapper routes from and mutates agent.ctx,
        // which may describe a different provider/model than this utility call.
        { exclude: ['fallback-model'] },
      )(agent.ctx, request),
    compactor: container.resolve(TOKENS.Compactor),
  });

  // Director / autonomy mode, fleet paths, eternal-engine scaffolding,
  // Agent Monitor — extracted to wiring/director-setup.ts.
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

  // ── Global Brain chain → BrainMonitor → shadow → MultiAgentHost → tools ──
  // Extracted to wiring/brain-and-orchestration.ts. NOTE: setupHqTelemetry()
  // is called between brain chain and brain monitor — the extracted function
  // handles both halves around that call.
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

  // HQ command dispatch + telemetry bridges (WebSocket, session/fleet/brain/
  // worktree/tool/cost telemetry, agent-monitor forwarding) — extracted to
  // wiring/hq-telemetry.ts.
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

  // Dep-watcher consumers (tech-stack + package-outdated) — extracted to wiring/dep-watcher.ts
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

  // Eagerly build the director so its LLM-callable orchestration
  // tools (`spawn_subagent`, `assign_task`, `await_tasks`,
  // `ask_subagent`, `roll_up`, `terminate_subagent`, `fleet`) get registered into the leader's ToolRegistry
  // *before* the agent starts streaming. Without this the leader has
  // no way to discover the fleet surface. Pass `FLEET_ROSTER`
  // so `spawn_subagent` can accept `role: 'bug-hunter'` shortcuts.
  director = await multiAgentHost.ensureDirector();
  if (director) {
    // If we resumed a prior run, inject the checkpoint snapshot so the
    // director's in-memory state mirrors the pre-crash fleet. This re-attaches
    // the checkpoint and pins the live maxSpawns ceiling from the current
    // profile; the historical usedSpawns counter is intentionally NOT
    // restored — the lifetime budget restarts with this director run.
    if (priorFleetState) director.setCheckpointState(priorFleetState);
    for (const tool of director.tools(FLEET_ROSTER)) {
      toolRegistry.register(tool);
    }
    // When a browser surface owns the UI, this terminal is only a server
    // host — collapse the roster dump (70+ role names) and the four path
    // lines into one. The full listing stays for CLI/TUI runs, where it is
    // the only place the fleet layout is visible.
    const browserSurface = flags.webui === true || flags.simpleui === true;
    if (browserSurface) {
      renderer.writeInfo(
        `Director mode enabled (${Object.keys(FLEET_ROSTER).length} roles) → ${fleetRoot}`,
      );
    } else {
      renderer.writeInfo(`Director mode enabled. Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`);
      renderer.writeInfo(`  fleet root → ${fleetRoot}`);
      renderer.writeInfo(`  manifest   → ${manifestPath}`);
      renderer.writeInfo(`  scratchpad → ${sharedScratchpadPath}`);
      renderer.writeInfo(`  subagents  → ${subagentSessionsRoot}`);
    }
    if (priorFleetState) {
      const budget = multiAgentHost.budgetView();
      const fmt = (n: number) => (Number.isFinite(n) ? String(n) : '∞');
      renderer.writeInfo(
        `  fleet budget → ${budget.usedSpawns}/${fmt(budget.maxSpawns)} spawns used` +
          ` (${fmt(budget.remainingSpawns)} remaining; maxConcurrent ${budget.maxConcurrent})`,
      );
      if (budget.ceilingMismatch && budget.checkpointMaxSpawns !== undefined) {
        renderer.writeInfo(
          `  ⚠ checkpoint maxSpawns was ${budget.checkpointMaxSpawns}; live ceiling is ${fmt(budget.maxSpawns)}`,
        );
      }
    }
  } else {
    renderer.writeInfo(`Running without Director — fleet orchestration tools disabled.`);
  }

  // Shared controller for the `/fleet stream on|off` toggle. The TUI
  // replaces `setEnabled` with a dispatch-backed setter on mount; before
  // that the no-op setter just keeps `enabled` in sync so callers see a
  // stable view even when invoked from a non-TUI surface.
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
    setConfig: (nextConfig) => {
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
      setConfig: (nextConfig) => {
        config = nextConfig;
      },
      configStore,
      profileConfigPath,
      context,
      effectiveMaxContext: effectiveMaxContextRef,
      autoCompactor,
      events,
      setEventMaxContext: eventWiring.setEffectiveMaxContext,
      mcpRegistry,
      onYolo: setYoloMode,
      getNextPredict: () => nextPredictEnabled,
      setNextPredict: (enabled) => {
        nextPredictEnabled = enabled;
      },
      getCurrentSuggestions: () => currentSuggestions,
      setCurrentSuggestions: (suggestions) => {
        currentSuggestions = suggestions;
      },
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
  for (const cmd of slashCmds) slashRegistry.register(cmd);

  // ── --eternal "<mission>" flag: one-shot launch into eternal autonomy. ──
  // See `cli-eternal-flag.ts` for the full contract. The flag is parsed
  // here so we can early-return without it; the side effects (YOLO on,
  // engine prime, autonomyMode flip) all live in the helper.
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
    // WITHOUT this the helper primed an engine and dropped it: the only live
    // holder is the `eternalEngine` binding below, written solely by the slash
    // handler. `--eternal "<mission>"` therefore forced YOLO on and set the
    // mode to 'eternal', then the REPL found no engine, printed "no engine
    // wired — falling back to off" on EVERY loop iteration without actually
    // flipping the mode back or `continue`-ing, and left the user staring at
    // unconfirmed tool calls. `cli-eternal-flag.test.ts` passes this ref, so
    // the test exercised a wiring production never had.
    // The live holder is `EternalAutonomyEngine | null`; the ref contract is
    // `| undefined`. Bridge rather than widen either side.
    eternalEngineRef: {
      get current() {
        return eternalEngine ?? undefined;
      },
      set current(engine) {
        eternalEngine = engine ?? null;
      },
    },
  });
  // Sync local `config` with any mutation the helper applied (e.g. yolo
  // flag flip). Using a ref keeps the helper's call site clean — no return
  // value juggling for callers that don't care about the update.
  config = configRef.current;
  if (eternalFlag.length > 0) {
    autonomyMode = 'eternal';
  }

  // Automatic codebase indexing: blocking startup index (with a visible
  // summary) + background reindex on agent edits and external file changes.
  // Runs here so the startup index completes before any front-end mounts.
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
  // The interactive graph — every slash command, the wiring layer, and with
  // them @wrongstack/sdd, /acp, /sage and /security-scanner — hangs off this
  // one module. Importing it statically meant `wstack version` and
  // `wstack mailbox serve`, which are dispatched long before this line, still
  // paid for all of it at boot.
  const { execute } = await import('./execution.js');
  // Keep one shared watchdog for CLI and any UI surface mounted by this process.
  const stopHeapWatchdog = startSharedHeapWatchdog({
    collectStats: () => {
      const hqQueue = hqPublisherRef.current?.getQueueStats();
      const hqSnapshot = brainMailbox.getHqSnapshotStats();
      const kanbanSync = hqPublisherRef.getKanbanSyncStats?.();
      return {
        surface: flags.simpleui
          ? 'simpleui'
          : flags.webui
            ? 'webui'
            : tuiOwnsScreen
              ? 'tui'
              : 'cli',
        sessionId: context.session.id,
        messages: context.state.messages.length,
        messageEstimatedTokens: context.state.messages.reduce(
          (sum, message) => sum + (message._estTokens ?? 0),
          0,
        ),
        metricsDroppedObservations: metricsSink?.droppedObservations() ?? 0,
        ...(hqQueue
          ? {
              hqQueueEntries: hqQueue.entries,
              hqQueueBytes: hqQueue.bytes,
              hqQueueMaxBytes: hqQueue.maxBytes,
              hqQueueDroppedFrames: hqQueue.droppedFrames,
              hqQueueDroppedBytes: hqQueue.droppedBytes,
              hqQueueCoalescedFrames: hqQueue.coalescedFrames,
              hqQueueCoalescedBytes: hqQueue.coalescedBytes,
            }
          : {}),
        hqSnapshotInFlight: hqSnapshot.inFlight ? 1 : 0,
        hqSnapshotPending: hqSnapshot.pending ? 1 : 0,
        hqSnapshotTimerScheduled: hqSnapshot.timerScheduled ? 1 : 0,
        hqEventInFlight: hqSnapshot.eventInFlight ? 1 : 0,
        hqEventPending: hqSnapshot.pendingEvents,
        hqEventCoalesced: hqSnapshot.coalescedEvents,
        hqEventDropped: hqSnapshot.droppedEvents,
        kanbanSyncActive: kanbanSync?.localPublishActive ? 1 : 0,
        kanbanSyncPendingBoards: kanbanSync?.pendingBoardIds ?? 0,
        kanbanSyncFullRescanPending: kanbanSync?.fullRescanPending ? 1 : 0,
        kanbanSyncRemoteApplyQueued: kanbanSync?.remoteApplyQueued ? 1 : 0,
        kanbanSyncPendingRemoteBoards: kanbanSync?.pendingRemoteBoards ?? 0,
        kanbanSyncPublishRuns: kanbanSync?.localPublishRuns ?? 0,
        kanbanSyncCoalescedRefreshes: kanbanSync?.coalescedLocalRefreshes ?? 0,
      };
    },
  });
  // teardownHandlers are sync-only; watchdog stop is best-effort.
  teardownHandlers.push(() => {
    void stopHeapWatchdog();
  });
  return execute(
    toExecuteDeps({
      core: {
        agent,
        events,
        slashRegistry,
        tokenCounter,
        activateSessionIdentity: activateSession,
        config,
        configStore,
        wpaths,
        projectRoot,
        flags,
        positional,
        webuiSessionChild,
        // Forward preflight's update-info so the TUI banner can render
        // the "(update available: v…)" indicator next to the version
        // chip. May be undefined (e.g. when the registry check was
        // aborted) — the TUI handles the absent case gracefully.
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
        agentTranscripts: agentMonitor,
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
          config = nextConfig;
          configRef.current = nextConfig;
        },
        statuslineHiddenItems,
        setStatuslineHiddenItems,
        saveStatuslineHiddenItems,
        getYolo: setYoloMode,
        onYolo: setYoloMode,
        getAutonomy: () => autonomyMode,
        setAutonomy: (mode) => {
          autonomyMode = mode;
        },
        getNextPredict: () => nextPredictEnabled,
        setNextPredict: (enabled) => {
          nextPredictEnabled = enabled;
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
        setConfig: (nextConfig) => {
          config = nextConfig;
        },
        profileConfigPath,
        mcpRegistry,
        toolRegistry,
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
          currentSuggestions = suggestions;
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

// `index.ts` owns is-main detection and bounded process exit. Recovery
// prompting and every other phase remain independently testable modules.
