/**
 * Top-level CLI phase orchestrator.
 * Boot, command-host, runtime, surface, and shutdown behavior belongs in
 * focused modules; this file owns their ordering and data hand-off only.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { GlobalMailbox, mailboxSessionTag } from '@wrongstack/core/coordination';
import type { Config, SystemPromptBuilder } from '@wrongstack/core/types';
import { createFallbackManageTools, createPluginManagerTool } from '@wrongstack/core/tools';
import { FLEET_ROSTER } from '@wrongstack/core/coordination';
import { gatedEnhancerReasoning } from '@wrongstack/core/execution';
import { TOKENS } from '@wrongstack/core/kernel';
import { ToolRegistry } from '@wrongstack/core/registry';
import { writeErr } from '@wrongstack/core/utils';
import { createAuthPanelHost } from './auth-menu/panel-service.js';
import { wireEventWiring } from './boot/event-wiring.js';
import { configureSimpleUiRuntimeContext } from './boot/simpleui-full-auto.js';
import { resolveModeAndCapabilities } from './boot/system-prompt.js';
import { bindSystemPromptBuilder } from './boot/system-prompt-builder.js';
import { registerBuiltinTools } from './boot/tool-registry.js';
import { initializeCli } from './cli-context.js';
import { launchEternalFromFlag } from './cli-eternal-flag.js';
import { promptRecovery } from './cli-recovery-prompt.js';
import { refreshRuntimeModelCatalog } from './context-limit.js';
import { execute } from './execution.js';
import { PLUGIN_AUDIT_ENTRIES, runPluginManagementCommand } from './plugin-management.js';
import { activeProfileConfigPath } from './profile-config-path.js';
import { buildPickableProviders } from './provider-helpers.js';
import { wireSessionEvents } from './session-event-wiring.js';
import { SessionStats } from './session-stats.js';
import { buildCommandHostSlashCommands } from './wiring/slash-commands.js';
import { CLI_VERSION } from './version.js';
import { setupBrainAndOrchestration } from './wiring/brain-and-orchestration.js';
import { createCommandHostAdapters } from './wiring/command-host-adapters.js';
import { setupCommandHostState } from './wiring/command-host-state.js';
import { setupDepWatcherConsumers } from './wiring/dep-watcher.js';
import { setupDirectorAndAutonomy } from './wiring/director-setup.js';
import { createEternalCommandHandlers } from './wiring/eternal-command-handlers.js';
import { createFleetCommandHandlers } from './wiring/fleet-command-handlers.js';
import { setupHqTelemetry } from './wiring/hq-telemetry.js';
import { setupLifecycleAndPlugins } from './wiring/lifecycle-plugins.js';
import { setupMetrics } from './wiring/metrics.js';
import { setupPipelines } from './wiring/pipeline.js';
import { setupSessionRegistry } from './wiring/session-registry.js';
import { setupDepWatcherBridge } from './wiring/dep-watcher-bridge.js';
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
import { createRuntimeLifecycleDeps } from './wiring/runtime-lifecycle-deps.js';
import { createRuntimePickerDeps } from './wiring/runtime-picker-deps.js';
import { prepareRuntimeDispatch } from './wiring/runtime-dispatch-state.js';
import { createSessionCommandHandlers } from './wiring/session-command-handlers.js';
import { createSddHandlers } from './wiring/sdd-handlers.js';
import { setupSession } from './wiring/session.js';
import { toExecuteDeps } from './wiring/to-execute-deps.js';

export { CLI_VERSION };

export async function main(argv: string[]): Promise<number> {
  // Issue #29 cli-main PR 7 — the first ~150 lines of boot/wiring
  // have been consolidated into `initializeCli()` in cli-context.ts.
  const cliCtx = await initializeCli(argv);
  if (typeof cliCtx === 'number') return cliCtx;

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
  } = cliCtx;
  const profileConfigPath = activeProfileConfigPath(wpaths, config);

  // PR 4 of Issue #29: mode + provider + modelCapabilities
  // resolution is now in `resolveModeAndCapabilities()`. The
  // helper returns a discriminated union; on `kind: 'exit'`
  // we teardown the reader and return the exit code (the
  // pre-refactor inline writeErr + reader.close + return 2
  // shape, now in one place).
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
  // PR 5 of Issue #29: SystemPromptBuilder binding is now
  // a single helper call. The helper takes the same forward
  // declarations and reads them lazily through the same
  // closure shape — no behavior change.
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

  // Tool registry — PR 6 of Issue #29. The 18-line
  // registration block (context manager + memory tools +
  // mailbox tools) is now a single helper call. The helper
  // takes the pre-constructed ToolRegistry, the feature
  // flags, the memory store, the events bus, and the
  // project dir; it does not touch the container.
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
  const fallbackManageTools = createFallbackManageTools({
    getConfig: () => configStore.get(),
    updateConfig: async (mutate: (cfg: Record<string, unknown>) => void) => {
      const raw = await fs.readFile(profileConfigPath, 'utf8').catch(() => '{}');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      mutate(parsed);
      await fs.writeFile(profileConfigPath, JSON.stringify(parsed, null, 2), { mode: 0o600 });
      configStore.update(parsed as Parameters<typeof configStore.update>[0]);
    },
    // Interactive key entry for REPL mode — reads a line from stdin without echo.
    // When the TUI owns the screen, standalone input is avoided (will be plumbed
    // through the TUI's own prompt mechanism in a follow-up).
    ...(stdinInteractive
      ? {
          requestInput: async (prompt: string): Promise<string> => {
            const { createInterface } = await import('node:readline');
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            return new Promise<string>((resolve) => {
              rl.question(`\n${prompt}\n> `, (answer) => {
                rl.close();
                resolve(answer);
              });
            });
          },
        }
      : {}),
  });
  for (const tool of fallbackManageTools) toolRegistry.register(tool);

  // Give the leader a single tool-calling surface for discovering and managing
  // plugins. Config mutations reuse the same implementation as `/plugin`, while
  // live tool discovery comes from the registry after plugin setup completes.
  toolRegistry.register(
    createPluginManagerTool({
      getConfig: () => configStore.get(),
      catalog: PLUGIN_AUDIT_ENTRIES.map((entry) => {
        const aliases = [
          ...(entry.name.startsWith('@wrongstack/') ? [] : [`@wrongstack/plugins/${entry.name}`]),
          ...(entry.name === '@wrongstack/plug-lsp' ? ['lsp'] : []),
          ...(entry.name === 'telegram' ? ['@wrongstack/telegram'] : []),
        ];
        return {
          name: entry.name,
          description: entry.summary,
          risk: entry.risk,
          defaultState: entry.defaultState,
          canDisable: entry.canDisable,
          ...(aliases.length > 0 ? { aliases } : {}),
        };
      }),
      toolRegistry,
      // Invariant: runPluginManagementCommand writes the mutated config to disk
      // AND returns a `patch` for every enabling/disabling branch, so re-applying
      // the patch here keeps configStore in sync with the persisted file. Unlike
      // createFallbackManageTools.updateConfig above, no defensive re-read is
      // needed as long as this contract holds for future mutation branches.
      setEnabled: async (plugin, enabled) => {
        const result = await runPluginManagementCommand([enabled ? 'enable' : 'disable', plugin], {
          config: configStore.get(),
          configPath: profileConfigPath,
        });
        if (result.patch) {
          configStore.update(result.patch as never as Partial<Config>);
        }
        return {
          ok: result.code === 0,
          message: result.message,
          restartRequired: result.restartRequired === true,
        };
      },
    }),
  );

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
  // Variadic helper: EventBus is dynamically typed per-event, but evOn needs to
  // register many events with different payload shapes. (...args: any) keeps the
  // handler body type-safe while Biome only flags the parameter declaration line.
  const evOn = (
    event: string,
    handler: (
      // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatch — callers use typed payloads
      ...args: any
    ) => void,
  ) => {
    // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatcher signature
    (events.on as (e: string, h: (...args: any) => void) => void)(event, handler);
    teardownHandlers.push(() =>
      // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatcher signature
      (events.off as (e: string, h: (...args: any) => void) => void)(event, handler),
    );
  };

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
  let onlineAgents: Awaited<ReturnType<GlobalMailbox['getAgentStatuses']>> = [];
  if (flags['simpleui'] !== true) {
    try {
      const systemMailbox = new GlobalMailbox(wpaths.projectDir);
      onlineAgents = await systemMailbox.getAgentStatuses();
    } catch {
      // Non-fatal — mailbox errors should not block prompt building
    }
  }

  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
  });

  // Session — extracted to wiring/session
  const sessionStore = container.resolve(TOKENS.SessionStore);
  const tokenCounter = container.resolve(TOKENS.TokenCounter);
  tokenCounter.setSessionId?.(() => sessionRef.current?.id);
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
    onRecovery: (abandoned, autoRecover) =>
      promptRecovery(reader, renderer, abandoned, autoRecover),
  });
  const session = sessResult.session;
  sessionRef.current = session;
  const context = sessResult.context;
  configureSimpleUiRuntimeContext(context.meta, flags);
  const attachments = sessResult.attachments;
  const recoveryLock = sessResult.recoveryLock;
  const queueStore = sessResult.queueStore;
  const planPath = sessResult.planPath;
  const detachTodosCheckpoint = sessResult.detachTodosCheckpoint;
  const priorFleetState = sessResult.priorFleetState;

  // ── Memory store trace ID ─────────────────────────────────────────
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
  const { tracker } = await setupSessionRegistry({
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

  const { buildProviderForId, switchProviderAndModel } = setupProviderRuntime({
    config,
    onConfigUpdate: (newConfig) => {
      config = newConfig;
    },
    configStore,
    fallbackProfileManager,
    providerRegistry,
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
    compactor: container.resolve(TOKENS.Compactor),
  });

  // Director / autonomy mode, fleet paths, eternal-engine scaffolding,
  // Agent Monitor — extracted to wiring/director-setup.ts.
  let {
    director,
    maxConcurrent,
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
      effectiveMaxContextRef,
      mcpRegistry,
      sessResult,
      modeId,
      statusTracker,
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
    // director's in-memory state mirrors the pre-crash fleet.
    if (priorFleetState) director.setCheckpointState(priorFleetState);
    for (const tool of director.tools(FLEET_ROSTER)) {
      toolRegistry.register(tool);
    }
    renderer.writeInfo(`Director mode enabled. Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`);
    renderer.writeInfo(`  fleet root → ${fleetRoot}`);
    renderer.writeInfo(`  manifest   → ${manifestPath}`);
    renderer.writeInfo(`  scratchpad → ${sharedScratchpadPath}`);
    renderer.writeInfo(`  subagents  → ${subagentSessionsRoot}`);
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
      getSddRuntimeState: async () => {
        const sdd = await import('./services/sdd-runtime.js');
        return {
          tracker: sdd.getTaskTracker(),
          builder: sdd.getActiveBuilder(),
          graphId: sdd.getTaskGraphId(),
        };
      },
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

  // Dispatch to execution phase — single-shot, TUI, REPL, or WebUI.

  const savedProviderCfg = config.providers?.[config.provider];
  return execute(
    toExecuteDeps({
      core: {
        agent,
        events,
        slashRegistry,
        tokenCounter,
        config,
        configStore,
        recoveryLock,
        wpaths,
        projectRoot,
        flags,
        positional,
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
        savedProviderCfg: savedProviderCfg as import('@wrongstack/core/types').ProviderConfig | undefined,
        resolvedProvider: resolvedProvider ?? undefined,
        getPickableProviders: async () => {
          await refreshRuntimeModelCatalog({
            modelsRegistry,
            logger,
            reason: 'model-picker',
          });
          return buildPickableProviders(modelsRegistry, config);
        },
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
        getEnhancerReasoning: () => gatedEnhancerReasoning(activeReasoningConfig),
        buildProviderForId,
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
  );
}

// `index.ts` owns is-main detection and bounded process exit. Recovery
// prompting and every other phase remain independently testable modules.
