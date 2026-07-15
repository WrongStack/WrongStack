/**
 * cli-main — top-level CLI entry point.
 *
 * This module is the orchestrator: it parses argv, calls
 * `boot(argv)` to build a `BootContext`, then dispatches to
 * the right sub-mode (REPL, webui, eternal, subcommand, etc.).
 *
 * After the Issue #29 refactor (PRs 0–7), the boot sequence
 * is split into focused helpers under `packages/cli/src/boot/`.
 * Each phase has a single, testable home:
 *
 *   - argv parsing             — `parseArgs` in `./arg-parser.js`
 *   - pre-boot side effects    — `runPreflight` in `./boot/preflight.js`       (PR 2)
 *   - env defaults             — inline (lines 126–130)                         (PR 1)
 *   - container wiring         — `wireContainer` in `./boot/container-wiring.js` (PR 3)
 *   - mode + capabilities      — `resolveModeAndCapabilities` in `./boot/system-prompt.js` (PR 4)
 *   - SystemPromptBuilder bind — `bindSystemPromptBuilder` in `./boot/system-prompt-builder.js` (PR 5)
 *   - tool registry            — `registerBuiltinTools` in `./boot/tool-registry.js` (PR 6)
 *   - final pass + re-exports  — this file's doc + the boot module map          (PR 7, this file)
 *
 * If you're adding a new boot phase, put it in a new
 * `boot/<phase>.ts` file and call it from `main()` in the
 * order shown above. Do not inline it.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type AutonomyStage,
  AgentError,
  allServers,
  attachDepWatcherBridge,
  type Config,
  color,
  type AuditLevel,
  EternalAutonomyEngine,
  expectDefined,
  FLEET_ROSTER,
  gatedEnhancerReasoning,
  GlobalMailbox,
  isStdinTTY,
  resolveEnhanceFallbackRef,
  loadDirectorState,
  mailboxSessionTag,
  ParallelEternalEngine,
  resolveFleetChatVerbosity,
  type LogLevel,
  type SystemPromptBuilder,
  TOKENS,
  ToolRegistry,
  writeErr,
  writeOut,
  getToolDescriptionMode,
  createCouncilTool,
  createOneShotLLMTool,
  OneShotOrchestrator,
} from '@wrongstack/core';
import { SddRunRegistry } from '@wrongstack/sdd';
import { wireSessionEvents } from './session-event-wiring.js';
import { initializeCli } from './cli-context.js';
import { createAuthPanelHost } from './auth-menu/panel-service.js';
import { createAutoPhaseHost } from './autophase-host.js';
import { registerBuiltinTools } from './boot/tool-registry.js';
import { configureSimpleUiRuntimeContext } from './boot/simpleui-full-auto.js';
import { launchEternalFromFlag } from './cli-eternal-flag.js';
import { promptRecovery } from './cli-recovery-prompt.js';
import { bindSystemPromptBuilder } from './boot/system-prompt-builder.js';
import { refreshRuntimeModelCatalog } from './context-limit.js';
import { execute } from './execution.js';
import { PLUGIN_AUDIT_ENTRIES, runPluginManagementCommand } from './plugin-management.js';
import { buildPickableProviders } from './provider-helpers.js';
import { SessionStats } from './session-stats.js';
import { deriveFsAccessPair } from './settings-menu.js';
import { createGracefulShutdown } from './shutdown-cleanup.js';
import type { CommitLLMProvider } from './slash-commands/commit-llm.js';
import { generateCommitMessageWithLLM } from './slash-commands/commit-llm.js';
import { makeProviderClassifier } from './slash-commands/dispatch-llm.js';
import { buildBuiltinSlashCommands } from './slash-commands/index.js';
import { parseMcpArgs, runMcpManagementCommand } from './slash-commands/mcp-utils.js';
import {
  DEFAULTS,
  STATUSLINE_CONFIG_KEYS,
  ensureStatuslineConfig,
  saveStatuslineConfig,
  type StatuslineConfigKey,
} from './slash-commands/statusline.js';
import { getSuggestions, setSuggestions } from './slash-commands/suggestion-store.js';
import { fmtTaskResultLine, patchConfig } from './utils.js';
import { CLI_VERSION } from './version.js';
import { setupCodebaseIndexing } from './wiring/codebase-index.js';
import { toExecuteDeps } from './wiring/to-execute-deps.js';
import {
  createAgentsMonitorController,
  createEnhanceController,
  createFleetStreamController,
  createInterruptController,
  createStatuslineConfigDeps,
} from './wiring/controllers.js';
import { setupSuperMemory } from './wiring/super-memory.js';
import { setupDepWatcherConsumers } from './wiring/dep-watcher.js';
import { setupHqTelemetry } from './wiring/hq-telemetry.js';
import { setupDirectorAndAutonomy } from './wiring/director-setup.js';
import { setupLifecycleAndPlugins } from './wiring/lifecycle-plugins.js';
import { setupBrainAndOrchestration } from './wiring/brain-and-orchestration.js';
import { setupProviderRuntime } from './wiring/provider-runtime-setup.js';
import { setupMetrics } from './wiring/metrics.js';
import { setupPipelines } from './wiring/pipeline.js';
import {
  buildProviderForId as buildProviderForIdRuntime,
  resolveProviderCfg as resolveProviderCfgRuntime,
} from './wiring/provider-runtime.js';
import { setupSession } from './wiring/session.js';
import { resolveModeAndCapabilities } from './boot/system-prompt.js';
import { wireEventWiring } from './boot/event-wiring.js';

export { CLI_VERSION };

type SddParallelRunGlobal = typeof globalThis & {
  __sddParallelRun?: import('@wrongstack/sdd').SddParallelRun | undefined;
};

type PluginPickerItem = {
  name: string;
  enabled: boolean;
  risk: 'low' | 'medium' | 'high';
  summary: string;
  lockable?: boolean | undefined;
};

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
  } = cliCtx;

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
  const sessionRef: { current: import('@wrongstack/core').SessionWriter | undefined } = {
    current: undefined,
  };
  // Forward declaration: the autonomy mode state lives later in this
  // function but the SystemPromptBuilder needs a reference to it NOW so
  // the autonomy contributor can read the current mode at build time.
  // Mutated by `onAutonomy` / `onEternalStart` below — the contributor
  // reads it on every system-prompt build (per turn).
  const autonomyModeRef: {
    current: import('./slash-commands/autonomy.js').AutonomyMode;
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
  let tracker: import('@wrongstack/core').AgentStatusTracker | undefined;
  try {
    const { getSessionRegistry, AgentStatusTracker, FleetNotifier } = await import(
      '@wrongstack/core'
    );
    const registry = getSessionRegistry(wpaths.globalRoot);
    const projectSlug = path.basename(wpaths.projectDir);
    const projectName = path.basename(projectRoot);

    // Detect current git branch (best-effort, non-blocking)
    let gitBranch: string | undefined;
    try {
      const { execSync } = await import('node:child_process');
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectRoot,
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
        .toString()
        .trim();
      if (gitBranch === 'HEAD') gitBranch = undefined; // detached HEAD
    } catch {
      // Not a git repo or git not available — leave undefined
    }

    await registry.register({
      sessionId: session.id,
      projectSlug,
      projectRoot,
      projectName,
      workingDir: context.workingDir,
      gitBranch,
      // The TUI and the REPL both boot through cli-main; `tuiOwnsScreen`
      // distinguishes the surface so the Fleet HQ map can label this session.
      clientType: tuiOwnsScreen ? 'tui' : 'cli',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    // Push-on-write: nudge same-project WebUIs the instant our agents advance,
    // so the Fleet HQ map reflects this TUI/REPL in ~ms (not watch/poll lag).
    const fleetNotifier = new FleetNotifier({
      baseDir: wpaths.globalRoot,
      projectRoot,
      selfPid: process.pid,
    });
    tracker = new AgentStatusTracker({
      events,
      registry,
      sessionId: () => context.session.id,
      onUpdate: () => fleetNotifier.notify(),
    });
    tracker.start();

    // Graceful shutdown. `registry.markClosing()` is an awaited atomic disk
    // write; calling `process.exit(0)` immediately after `void cleanup()` cut
    // the write off and left the cross-process registry thinking the host was
    // still alive after Ctrl+C. `createGracefulShutdown` matches the
    // established pattern in webui-server/lifecycle.ts + cli-entry-point.ts:
    // await the cleanup, set `exitCode`, give Node a 500ms grace to drain,
    // then force exit. A second signal short-circuits to immediate exit.
    createGracefulShutdown({
      run: async () => {
        try {
          fleetNotifier.dispose();
          await registry.markClosing();
          tracker?.stop();
        } catch {
          /* ignore — a stuck cleanup cannot wedge the exit path */
        }
      },
    }).install();
  } catch {
    // Non-critical — session tracking degrades gracefully
  }

  // SessionEventBridge + audit events (extracted to session-event-wiring.ts).
  const { errorRing, sessionBridge } = wireSessionEvents({
    evOn,
    config: config as unknown as Record<string, unknown>,
    context: context as unknown as Record<string, unknown>,
    session,
    sessionRef,
    wpaths,
    projectRoot,
    renderer,
    tuiOwnsScreen,
  });

  const stats = new SessionStats(events, tokenCounter);

  // Live view of the active model's reasoning capabilities. Refreshed whenever
  // the provider/model changes so the model-runtime middleware can gate
  // reasoning/effort settings on what the model actually accepts.
  let activeReasoningConfig: import('@wrongstack/core').ReasoningConfig | undefined;
  const refreshActiveReasoningConfig = async (providerId: string, modelId: string) => {
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
  // When the file-watcher plugin's depWatcher.enabled config is true,
  // dependency manifest changes (package.json, go.mod, etc.) are posted
  // to the project-level mailbox for tech-stack audit.
  const fwCfg = config.extensions?.['file-watcher'] as Record<string, unknown> | undefined;
  const dwCfg = fwCfg?.['depWatcher'] as Record<string, unknown> | undefined;
  let depWatcherDispose: (() => void) | undefined;
  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
      const dwMailbox = new GlobalMailbox(projectDir, events);
      depWatcherDispose = attachDepWatcherBridge({
        events,
        mailbox: dwMailbox,
        projectRoot,
        targetAgent: (dwCfg['targetAgent'] as string) ?? 'tech-stack',
        watcherAgentId: 'dep-watcher',
        debounceMs: (dwCfg['debounceMs'] as number) ?? 3000,
      });
      logger.info(
        'Dep-watcher bridge activated — dependency changes will trigger tech-stack audits',
      );
    } catch (err) {
      logger.warn(`Failed to wire dep-watcher bridge: ${err}`);
    }
  }

  // Clean up dep-watcher bridge on teardown
  if (depWatcherDispose) {
    teardownHandlers.push(depWatcherDispose);
  }

  // ── Provider runtime helpers + fallback + switch + credential watcher ──
  // Extracted to wiring/provider-runtime-setup.ts.
  const {
    buildProviderForId,
    switchProviderAndModel,
  } = setupProviderRuntime({
    config,
    onConfigUpdate: (newConfig) => { config = newConfig; },
    configStore,
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
  });

  // Register the `llm` tool — one-shot LLM invocations with provider
  // resolution and fallback chain. buildProviderForId is now available.
  const llmTool = createOneShotLLMTool({
    buildProvider: buildProviderForId,
    getConfig: () => config,
    defaultProvider: config.provider,
    defaultModel: config.model,
  });
  try {
    toolRegistry.register(llmTool);
  } catch {
    toolRegistry.override('llm', llmTool);
  }

  // Register the provider-neutral Council tool with the same OneShot runtime.
  const councilTool = createCouncilTool({
    caller: new OneShotOrchestrator({
      buildProvider: buildProviderForId,
      getConfig: () => config,
    }),
  });
  try {
    toolRegistry.register(councilTool);
  } catch {
    toolRegistry.override('council', councilTool);
  }

  // Wire a summarizer to the context_manager tool using the llm tool.
  try {
    const { createContextManagerTool } = await import('@wrongstack/core');
    // Create a simple summarizer that calls deepseek-chat (or fallback)
    // for context_manager summary actions.
    const { OneShotOrchestrator } = await import('@wrongstack/core');
    if (OneShotOrchestrator) {
      const summarizer = new OneShotOrchestrator({
        buildProvider: buildProviderForId,
        getConfig: () => config,
      });
      toolRegistry.override(
        'context_manager',
        createContextManagerTool({
          compactor: container.resolve(TOKENS.Compactor) as never,
          summarizer: async (messages) => {
            const r = await summarizer.call({
              system: 'Summarize concisely. Keep decisions and key facts.',
              messages,
              model: 'deepseek-chat',
              maxTokens: 1024,
              timeoutMs: 30_000,
            });
            return r.text || '(summary unavailable)';
          },
        }),
      );
    }
  } catch {
    // Best-effort — summarizer enhancement is optional.
  }

  // Director / autonomy mode, fleet paths, eternal-engine scaffolding,
  // Agent Monitor — extracted to wiring/director-setup.ts.
  let {
    director,
    directorMode,
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
  const {
    brain,
    brainLog,
    brainSettings,
    brainRuntime,
    multiAgentHost,
    shadowController,
  } = setupBrainAndOrchestration({
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
    projectRoot,
    cwd,
    wpaths,
    teardownHandlers,
    mailboxSessionTag,
    brainMailbox,
    agentMonitor,
    directorMode,
    manifestPath,
    sharedScratchpadPath,
    subagentSessionsRoot,
    stateCheckpointPath,
    fleetRootForPromotion,
    maxConcurrent,
    effectiveMaxContextRef,
    mcpRegistry,
    sessResult,
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

  if (directorMode) {
    // Eagerly build the director so its LLM-callable orchestration
    // tools (`spawn_subagent`, `assign_task`, `await_tasks`,
    // `ask_subagent`, `roll_up`, `terminate_subagent`, `fleet`) get registered into the leader's ToolRegistry
    // *before* the agent starts streaming. Without this the leader has
    // no way to discover the fleet surface and `--director` ends up as
    // a manifest-only flag with no orchestration. Pass `FLEET_ROSTER`
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
      renderer.writeInfo(`Director mode enabled. Fleet manifest → ${manifestPath}`);
    }
  }

  // Shared controller for the `/fleet stream on|off` toggle. The TUI
  // replaces `setEnabled` with a dispatch-backed setter on mount; before
  // that the no-op setter just keeps `enabled` in sync so callers see a
  // stable view even when invoked from a non-TUI surface.
  const fleetStreamController = createFleetStreamController(
    resolveFleetChatVerbosity(config.autonomy),
  );

  // Shared controller for the `/interrupt` slash command. The surface (TUI)
  // rebinds `abortLeader` on mount to abort its in-flight RunController; the
  // default no-op returns false (nothing to abort). The REPL installs its own
  // below. `/interrupt` pairs this with `onFleetKill` to stop everything.
  const interruptController = createInterruptController();
  // Wire the HQ command controller's leader-abort to the shared interrupt
  // controller so an HQ `abort leader` command reaches the live RunController
  // once the REPL/TUI rebinds `abortLeader`.
  hqCommandController.interruptLeader = () => interruptController.abortLeader();
  // Populate the fleet hooks lazily — `director` is null until --director or
  // /autonomy parallel promotes the host. An HQ command arriving before then
  // is cleanly rejected by the dispatcher (returns `undefined` → rejected).
  hqCommandController.killFleet = async () => {
    if (!director) return 0;
    const s = director.status();
    let killed = 0;
    for (const sa of s.subagents) {
      if (sa.status === 'running' || sa.status === 'idle') {
        try {
          await director.remove(sa.id);
          killed++;
        } catch { /* best-effort */ }
      }
    }
    return killed;
  };
  hqCommandController.terminateAgent = async (subagentId: string) => {
    if (!director) return false;
    try {
      await director.terminate(subagentId);
      return true;
    } catch {
      return false;
    }
  };
  hqCommandController.spawnAgent = async (role: string, task?: string, maxIterations?: number) => {
    if (!director) {
      throw new AgentError({
        message: 'No director active — start with --director or use /autonomy parallel.',
        code: 'AGENT_RUN_FAILED',
        context: { phase: 'hq-spawn', role },
      });
    }
    const base = FLEET_ROSTER[role] ?? {
      id: `manual-${Date.now()}`,
      name: role,
      maxIterations: maxIterations ?? 50,
      maxToolCalls: 200,
    };
    // Carry the optional task description into the spawn config so the
    // spawned agent picks it up as its initial instruction.
    const cfg = task !== undefined ? { ...base, task } : base;
    return director.spawn(cfg);
  };

  // Shared controller for the `/enhance on|off` prompt-refinement toggle.
  // Same pattern as `fleetStreamController`: the TUI rebinds `setEnabled` to a
  // dispatch-backed setter on mount. Seeded from persisted config (default on).
  const enhanceController = createEnhanceController(config);

  // Statusline config — loaded once and shared with /statusline slash command
  const statuslineConfigDeps = createStatuslineConfigDeps();

  // Statusline hidden items — derived from the config file, kept in sync with the TUI
  const hiddenItemsFromConfig = await ensureStatuslineConfig();
  const hiddenItemsList: StatuslineConfigKey[] = [];
  for (const k of STATUSLINE_CONFIG_KEYS) {
    if (!hiddenItemsFromConfig[k]) hiddenItemsList.push(k);
  }
  const statuslineHiddenItems = hiddenItemsList;
  let currentHiddenItems = [...statuslineHiddenItems];
  const setStatuslineHiddenItems = (items: StatuslineConfigKey[]) => {
    currentHiddenItems = items;
  };
  /** Atomically saves hidden items to disk and updates in-memory state. */
  const saveStatuslineHiddenItems = async (items: StatuslineConfigKey[]): Promise<void> => {
    currentHiddenItems = items;
    const cfg: import('./slash-commands/statusline.js').StatuslineConfig = { ...DEFAULTS };
    for (const k of STATUSLINE_CONFIG_KEYS) {
      cfg[k] = !items.includes(k);
    }
    await saveStatuslineConfig(cfg);
  };

  // Shared controller for the `/agents on|off` toggle. The TUI
  // replaces `setVisible` with a dispatch-backed setter on mount; before
  // that the no-op setter just keeps `visible` in sync so callers see a
  // stable view even when invoked from a non-TUI surface.
  const agentsMonitorController = createAgentsMonitorController();

  // Mutable ref for opening TUI panels from slash commands. The slash
  // commands call `onPanelOpen.current(action)` to open panels. The TUI
  // sets `onPanelOpen.current` to its actual dispatch function on mount.
  const onPanelOpen: { current: ((action: string) => boolean) | null } = {
    current: null,
  };

  // AutoPhase host — plans phases+todos via a subagent, then drives the
  // PhaseOrchestrator (one subagent per task) in the background. `getConfig`
  // reads the live `config` (it can be patched, e.g. YOLO toggles).
  const autoPhaseHost = createAutoPhaseHost({
    multiAgentHost,
    getConfig: () => config,
    events,
    getSessionId: () => sessionRef.current?.id ?? session.id,
    storeDir: wpaths.projectAutophase,
    projectRoot,
    brain,
    log: (line) => renderer.write(`${line}\n`),
  });

  // Mutable coordinator controller — execution.ts fills its callbacks when
  // the AutonomousCoordinator is created lazily. Slash commands read from it.
  const coordinatorController: NonNullable<
    Parameters<typeof buildBuiltinSlashCommands>[0]['coordinatorController']
  > = {};

  const setYoloMode = (setTo?: boolean): boolean => {
    const policy = container.resolve(TOKENS.PermissionPolicy);
    if (setTo !== undefined) {
      policy.setYolo?.(setTo);
      config = patchConfig(config, { yolo: setTo });
      return setTo;
    }
    return policy.getYolo?.() ?? config.yolo ?? false;
  };

  // Registry of the active multi-agent SDD board run. The webui board handler
  // and slash hooks steer the run through this; the run itself is CLI-owned.
  const sddRunRegistry = new SddRunRegistry();

  // One-shot orphan sweep on boot — remove worktrees/branches a crashed or
  // abandoned SDD run left behind so they never accumulate across sessions.
  // Liveness-guarded (skips a run live in another process) + best-effort;
  // fire-and-forget so it never delays startup.
  void import('@wrongstack/sdd')
    .then((m) => m.cleanupStaleSddWorktrees({ projectRoot, boardsDir: wpaths.projectSddBoards }))
    .catch(() => undefined);

  const slashCmds = buildBuiltinSlashCommands({
    registry: slashRegistry,
    toolRegistry,
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
    statuslineHiddenItems: [...currentHiddenItems],
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    agentsMonitorController,
    agentMonitor,
    onPanelOpen,
    configStore,
    reader,
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog: () => brainLog,
    coordinatorController,
    shadowController,
    confirm: async (question, defaultYes = true): Promise<boolean | null> => {
      // Non-TTY / piped stdin → don't block. For destructive or surprising
      // actions (e.g. starting eternal mode against a stale goal) the safe
      // non-interactive default is `false` — auto-confirming destructive
      // operations in scripts is dangerous. `null` signals "no user to ask"
      // only when the caller explicitly needs to distinguish cancel from
      // deny (which /autonomy eternal doesn't).
      if (!isStdinTTY()) return false;
      const hint = defaultYes ? '[Y/n/q]' : '[y/N/q]';
      try {
        const raw = await reader.readLine(`  ${color.amber('?')} ${question} ${color.dim(hint)} `);
        const ans = raw.trim().toLowerCase();
        if (ans === 'q' || ans === 'quit' || ans === 'cancel') return null;
        if (ans === '') return defaultYes;
        return ans === 'y' || ans === 'yes';
      } catch {
        return false;
      }
    },
    onSpawn: async (description, spawnOpts) => {
      const { subagentId, taskId } = await multiAgentHost.spawn(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${tag} for task ${taskId}. Use /agents to track progress.`;
    },
    onSpawnAndWait: async (description, spawnOpts) => {
      const result = await multiAgentHost.spawnAndWait(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(spawnOpts.name);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';

      const secs = (result.durationMs / 1000).toFixed(result.durationMs < 10_000 ? 1 : 0);
      const icon =
        result.status === 'success'
          ? '✓'
          : result.status === 'timeout'
            ? '⏱'
            : result.status === 'stopped'
              ? '⊘'
              : '✗';
      const resultPreview =
        typeof result.result === 'string' && result.result.trim()
          ? `\n${color.dim('─'.repeat(40))}\n${result.result.trim().slice(0, 600)}${result.result.trim().length > 600 ? '\n…' : ''}\n${color.dim('─'.repeat(40))}`
          : '';

      return [
        `${icon} ${color.bold(tag ? tag.slice(1) : 'subagent')} ${result.status} (${result.iterations} iter · ${result.toolCalls} tools · ${secs}s)`,
        resultPreview,
        result.error ? `  ${color.amber(`error: ${result.error.message}`)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
    onAgents: (subagentId?: string) => {
      const s = multiAgentHost.status();
      // When given a specific subagent id, return a live monitor view.
      if (subagentId) {
        const live = s.live.find((a) => a.subagentId === subagentId);
        const completed = s.completed.filter((r) => r.subagentId === subagentId);
        const pending = s.pending.filter((p) => p.subagentId === subagentId);
        if (!live && completed.length === 0 && pending.length === 0) {
          return `No subagent found with id "${subagentId}".`;
        }
        const STATUS_ICON: Record<string, string> = {
          running: '●',
          idle: '○',
          stopped: '⊘',
        };
        const lines: string[] = [color.bold(`Agent ${subagentId.slice(0, 8)}`)];
        if (live) {
          lines.push(`  ${STATUS_ICON[live.status] ?? '?'}  status: ${live.status}`);
          if (live.task) lines.push(`  task: ${live.task}`);
        }
        for (const p of pending) {
          lines.push(`  ·  pending: ${p.taskId.slice(0, 8)} → ${p.description.slice(0, 60)}`);
        }
        for (const r of completed) {
          const fmt = fmtTaskResultLine(r, color);
          lines.push(`  ${fmt.mark}  ${r.taskId.slice(0, 8)} ${fmt.stats}${fmt.tail}`);
        }
        // Also surface per-subagent cost from fleet (action: usage) if director is active.
        if (director) {
          const snap = director.snapshot();
          const per = snap.perSubagent?.[subagentId];
          if (per?.cost) lines.push(`  cost: ${per.cost.toFixed(4)}`);
          if (per?.iterations) lines.push(`  iterations: ${per.iterations}`);
          if (per?.toolCalls) lines.push(`  toolCalls: ${per.toolCalls}`);
        }
        return lines.join('\n');
      }
      // No id — return the summary table.
      const lines = [s.summary];
      const STATUS_ICON: Record<string, string> = {
        running: '●',
        idle: '○',
        stopped: '⊘',
      };
      for (const a of s.live) {
        if (a.status === 'running' || a.status === 'idle') {
          const task = a.task ? ` — ${a.task.slice(0, 60)}` : '';
          lines.push(
            `  ${STATUS_ICON[a.status] ?? '?'}  ${a.subagentId.slice(0, 8)} ${a.status}${task}`,
          );
        }
      }
      for (const p of s.pending) {
        lines.push(`  ·  pending  ${p.taskId.slice(0, 8)} → ${p.description.slice(0, 60)}`);
      }
      for (const r of s.completed) {
        const fmt = fmtTaskResultLine(r, color);
        lines.push(`  ${fmt.mark}  ${r.taskId.slice(0, 8)} ${fmt.stats}${fmt.tail}`);
      }
      return lines.join('\n');
    },
    onFleet: async (action, target) => {
      if (action === 'status') {
        const s = multiAgentHost.status();
        const lines = [color.bold('Fleet status'), `  ${s.summary}`];
        const STATUS_ICON: Record<string, string> = {
          running: '●',
          idle: '○',
          stopped: '⊘',
        };
        const liveActive = s.live.filter((a) => a.status === 'running' || a.status === 'idle');
        if (liveActive.length > 0) {
          lines.push('', color.dim('  Active'));
          for (const a of liveActive) {
            const task = a.task ? ` · ${a.task.slice(0, 50)}` : '';
            lines.push(
              `    ${STATUS_ICON[a.status] ?? '?'} ${a.subagentId.slice(0, 8)} ${a.status}${task}`,
            );
          }
        }
        if (s.pending.length > 0) {
          lines.push('', color.dim('  Pending'));
          for (const p of s.pending) {
            lines.push(
              `    ·  ${p.taskId.slice(0, 8)} → ${p.subagentId.slice(0, 8)} · ${p.description.slice(0, 60)}`,
            );
          }
        }
        if (s.completed.length > 0) {
          lines.push('', color.dim('  Completed'));
          for (const r of s.completed) {
            const fmt = fmtTaskResultLine(r, color);
            lines.push(
              `    ${fmt.mark} ${r.taskId.slice(0, 8)} → ${r.subagentId.slice(0, 8)} · ${fmt.stats}${fmt.tail}`,
            );
          }
        }
        return lines.join('\n');
      }
      if (action === 'usage') {
        const u = multiAgentHost.usage();
        if (u.rows.length === 0) return 'No completed subagent tasks yet.';
        const lines = [
          color.bold('Fleet usage'),
          color.dim('  subagent          tasks  iter  tools     ms  status'),
        ];
        for (const r of u.rows) {
          lines.push(
            `  ${r.subagentId.slice(0, 14).padEnd(14)}  ${String(r.tasks).padStart(5)}  ${String(r.iterations).padStart(4)}  ${String(r.toolCalls).padStart(5)}  ${String(r.durationMs).padStart(5)}  ${r.status}`,
          );
        }
        lines.push(
          color.dim('  ─'.repeat(28)),
          `  ${'TOTAL'.padEnd(14)}  ${String(u.totals.tasks).padStart(5)}  ${String(u.totals.iterations).padStart(4)}  ${String(u.totals.toolCalls).padStart(5)}  ${String(u.totals.durationMs).padStart(5)}`,
        );
        return lines.join('\n');
      }
      if (action === 'kill') {
        if (!target) return 'Usage: /fleet kill <subagent-id>';
        const ok = await multiAgentHost.kill(target);
        return ok
          ? `Sent stop signal to ${target}.`
          : 'No coordinator is running yet — nothing to kill.';
      }
      if (action === 'manifest') {
        if (!multiAgentHost.isDirectorMode()) {
          return 'Manifest is only available when the run was started with --director.';
        }
        const p = await multiAgentHost.manifest();
        if (!p) {
          return 'Director is active but no subagents have been spawned — nothing to record yet.';
        }
        return `Manifest written → ${p}`;
      }
      if (action === 'concurrency') {
        const current = multiAgentHost.getMaxConcurrent();
        if (!target) {
          return `Concurrent-subagent ceiling: ${current}`;
        }
        const n = Number.parseInt(target, 10);
        if (!Number.isFinite(n) || n < 1) {
          return `Invalid value "${target}". Concurrency must be an integer >= 1.`;
        }
        try {
          multiAgentHost.setMaxConcurrent(n);
          events.emit('concurrency.changed', {
            sessionId: sessionRef.current?.id ?? session.id,
            n,
          });
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        return `Concurrent-subagent ceiling: ${current} → ${n}`;
      }
      return `Unknown fleet action: ${action}`;
    },
    onFleetStatus: () => {
      if (!director) return null;
      return director.status();
    },
    onFleetUsage: () => {
      if (!director) return null;
      return director.snapshot();
    },
    onFleetKill: async () => {
      if (!director) return 0;
      const s = director.status();
      // Kill and remove all subagents so their ids can be reused in future spawns.
      // Uses remove() rather than terminate() to also clean up the coordinator
      // entry and the usage aggregator, preventing resource accumulation.
      let killed = 0;
      for (const sa of s.subagents) {
        if (sa.status === 'running' || sa.status === 'idle') {
          try {
            await director.remove(sa.id);
            killed++;
          } catch {
            /* best-effort */
          }
        }
      }
      return killed;
    },
    onFleetTerminate: async (subagentId) => {
      if (!director) return false;
      try {
        await director.terminate(subagentId);
        return true;
      } catch {
        return false;
      }
    },
    onFleetSpawn: async (role) => {
      if (!director) {
        throw new AgentError({
          message: 'No director active — start with --director or use /autonomy parallel.',
          code: 'AGENT_RUN_FAILED',
          context: { phase: 'fleet-spawn', role },
        });
      }
      const cfg = FLEET_ROSTER[role] ?? {
        id: `manual-${Date.now()}`,
        name: role,
        maxIterations: 50,
        maxToolCalls: 200,
      };
      return director.spawn(cfg);
    },
    onFleetLog: async (subagentId, mode) => {
      // Per-subagent JSONLs live under <fleetRoot>/subagents/<runId>/<subagentId>.jsonl
      // and the runId is namespace-stable (session id by default), so we
      // walk the subagents dir to discover both runs and subagents.
      const subagentsRoot = path.join(fleetRootForPromotion, 'subagents');
      let runDirs: string[];
      try {
        runDirs = await fs.readdir(subagentsRoot);
      } catch {
        return 'No fleet transcripts on disk — no subagents have been spawned for this session.';
      }
      // Collect every transcript across every run-dir for this session.
      // Parallelize both layers: the per-run-dir readdir+stat scan is
      // independent across runs, and within a run the per-file stat calls
      // are independent. `Promise.all` is safe here because the workload
      // is bounded by `runDirs.length × files-per-run` and we don't hold
      // any shared mutable state during the scan — `found.push` only runs
      // after the per-run promise resolves.
      const found: Array<{ runId: string; subagentId: string; file: string; size: number }> = [];
      const runResults = await Promise.all(
        runDirs.map(
          async (
            runId,
          ): Promise<Array<{ runId: string; subagentId: string; file: string; size: number }>> => {
            const runDir = path.join(subagentsRoot, runId);
            let files: string[];
            try {
              files = await fs.readdir(runDir);
            } catch {
              return [];
            }
            // Per-file stat in parallel — bounded by files-in-this-run.
            const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
            const fileResults = await Promise.all(
              jsonlFiles.map(async (f) => {
                const full = path.join(runDir, f);
                try {
                  const stat = await fs.stat(full);
                  return {
                    runId,
                    subagentId: f.replace(/\.jsonl$/, ''),
                    file: full,
                    size: stat.size,
                  };
                } catch {
                  return null;
                }
              }),
            );
            return fileResults.filter((r): r is NonNullable<typeof r> => r !== null);
          },
        ),
      );
      for (const runResult of runResults) found.push(...runResult);
      if (found.length === 0) {
        return 'No subagent transcripts found on disk.';
      }
      // Listing mode (no id provided).
      if (!subagentId) {
        const lines = [
          `${found.length} subagent transcript${found.length === 1 ? '' : 's'} on disk:`,
        ];
        for (const t of found) {
          lines.push(
            `  ${color.cyan(t.subagentId.padEnd(18))}  ${color.dim(t.runId.slice(0, 18))}  ${color.dim(`${(t.size / 1024).toFixed(1)} KB`)}`,
          );
        }
        lines.push(
          'Use `/fleet log <subagentId>` for a summary, or append `raw` for the full JSONL.',
        );
        return lines.join('\n');
      }
      // Match by exact id or prefix; ambiguous matches return the list.
      const matches = found.filter(
        (t) => t.subagentId === subagentId || t.subagentId.startsWith(subagentId),
      );
      if (matches.length === 0) {
        return `No transcript matched "${subagentId}". Run \`/fleet log\` to list available ids.`;
      }
      if (matches.length > 1) {
        return [
          `Ambiguous id "${subagentId}" — ${matches.length} matches:`,
          ...matches.map((m) => `  ${m.subagentId}  (${m.runId})`),
        ].join('\n');
      }
      const t = expectDefined(matches[0]);
      const raw = await fs.readFile(t.file, 'utf8');
      if (mode === 'raw') return raw;

      // Summary: walk JSONL events, count types, list the first user/llm
      // pair + the last few iterations. Designed to fit in one terminal
      // screen even for verbose transcripts.
      const lines = raw.split('\n').filter((l) => l.trim());
      const counts: Record<string, number> = {};
      let firstUser: string | null = null;
      let lastResponse: string | null = null;
      let totalIterations = 0;
      const toolNames = new Map<string, number>();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as {
            type: string;
            content?: unknown | undefined;
            name?: string | undefined;
          };
          counts[ev.type] = (counts[ev.type] ?? 0) + 1;
          if (ev.type === 'user_input' && !firstUser) {
            const txt =
              typeof ev.content === 'string'
                ? ev.content
                : Array.isArray(ev.content)
                  ? ev.content
                      .filter(
                        (b): b is { type: 'text'; text: string } =>
                          (b as { type?: string | undefined }).type === 'text',
                      )
                      .map((b) => b.text)
                      .join(' ')
                  : '';
            firstUser = txt.slice(0, 120);
          }
          if (ev.type === 'llm_response') {
            if (Array.isArray(ev.content)) {
              const txt = (
                ev.content as Array<{ type?: string | undefined; text?: string | undefined }>
              )
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join(' ');
              if (txt) lastResponse = txt.slice(0, 240);
            }
            totalIterations += 1;
          }
          if (ev.type === 'tool_use' && typeof ev.name === 'string') {
            toolNames.set(ev.name, (toolNames.get(ev.name) ?? 0) + 1);
          }
        } catch {
          // skip malformed
        }
      }
      const toolBreakdown =
        toolNames.size > 0
          ? Array.from(toolNames.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([n, c]) => `${n}×${c}`)
              .join(', ')
          : '(none)';
      const out: string[] = [
        color.bold(`Subagent ${t.subagentId}`) + color.dim(`  (run ${t.runId})`),
        `  ${lines.length} events  ·  ${totalIterations} llm iterations  ·  ${(t.size / 1024).toFixed(1)} KB`,
        `  tools: ${toolBreakdown}`,
      ];
      if (firstUser) out.push('', color.dim('  task:'), `  ${firstUser}`);
      if (lastResponse) out.push('', color.dim('  last response:'), `  ${lastResponse}`);
      out.push('', color.dim('  event mix:'));
      for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        out.push(`    ${type.padEnd(20)} ${count}`);
      }
      out.push('', color.dim('Use `/fleet log <id> raw` for the full JSONL.'));
      return out.join('\n');
    },
    onFleetRetry: async (taskId) => {
      if (!multiAgentHost.isDirectorMode()) {
        const promoted = await multiAgentHost.promoteToDirector();
        if (!promoted) {
          return 'Cannot retry: a coordinator already exists in non-director mode.';
        }
        for (const tool of promoted.tools(FLEET_ROSTER)) {
          toolRegistry.register(tool);
        }
      }
      const dir = await multiAgentHost.ensureDirector();
      if (!dir) return 'Director is not available.';
      const dirStatePath = path.join(fleetRootForPromotion, 'director-state.json');
      const prior = await loadDirectorState(dirStatePath);
      if (!prior) {
        return 'No prior director-state.json found — nothing to retry.';
      }
      // "Interrupted" = whatever was running/pending when the previous
      // process died. Completed/failed/timeout/stopped tasks are final.
      const interrupted = prior.tasks.filter(
        (t) => t.status === 'running' || t.status === 'pending',
      );
      if (interrupted.length === 0) {
        return 'No interrupted tasks: every prior task reached a terminal state.';
      }

      // List mode — no target given.
      if (!taskId) {
        const lines = [
          `${interrupted.length} interrupted task${interrupted.length === 1 ? '' : 's'} from prior run:`,
        ];
        for (const t of interrupted) {
          const owner = t.subagentId
            ? prior.subagents.find((s) => s.id === t.subagentId)
            : undefined;
          const tag = owner ? `${owner.name ?? owner.id} (${owner.role ?? 'no-role'})` : 'no-owner';
          lines.push(
            `  ${t.taskId.slice(0, 12)}  ${t.status.padEnd(8)} ${tag}  ${(t.description ?? '').slice(0, 60)}`,
          );
        }
        lines.push('Run `/fleet retry <taskId>` or `/fleet retry all` to re-assign.');
        return lines.join('\n');
      }

      const targets =
        taskId === 'all'
          ? interrupted
          : interrupted.filter((t) => t.taskId === taskId || t.taskId.startsWith(taskId));
      if (targets.length === 0) {
        return `No interrupted task matched "${taskId}".`;
      }

      const results: string[] = [];
      for (const t of targets) {
        const owner = t.subagentId ? prior.subagents.find((s) => s.id === t.subagentId) : undefined;
        if (!owner) {
          results.push(`  - ${t.taskId.slice(0, 12)}: no owner record, skipped.`);
          continue;
        }
        // Re-spawn from the roster when role is set (preferred path —
        // role-based spawns get their full prompt/tool slice). Otherwise
        // synthesize a minimal SubagentConfig from the prior record.
        const rosterCfg = owner.role ? FLEET_ROSTER[owner.role] : undefined;
        const cfg = rosterCfg
          ? { ...rosterCfg }
          : {
              name: owner.name ?? owner.id,
              role: owner.role,
              provider: owner.provider,
              model: owner.model,
            };
        try {
          const newSubId = await dir.spawn(cfg);
          const newTaskId = await dir.assign({
            id: '',
            description: t.description ?? '(no description)',
            subagentId: newSubId,
          });
          results.push(
            `  ${color.green('✓')} ${t.taskId.slice(0, 12)} → re-spawned ${newSubId.slice(0, 12)} (task ${newTaskId.slice(0, 12)})`,
          );
        } catch (err) {
          results.push(
            `  ${color.red('✗')} ${t.taskId.slice(0, 12)} → ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return [`Retried ${targets.length} task${targets.length === 1 ? '' : 's'}:`, ...results].join(
        '\n',
      );
    },
    onDirector: async () => {
      const director = await multiAgentHost.promoteToDirector();
      if (!director) return null;
      // Register the 8 LLM-callable orchestration tools into the leader's
      // ToolRegistry so the agent can discover fleet surface mid-session.
      for (const tool of director.tools(FLEET_ROSTER)) {
        toolRegistry.register(tool);
      }
      const mp = path.join(fleetRootForPromotion, 'fleet.json');
      const sp = path.join(fleetRootForPromotion, 'shared');
      const ss = path.join(fleetRootForPromotion, 'subagents');
      const lines = [
        `${color.green('✓')} Promoted to director mode.`,
        `  Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`,
        `  Manifest → ${mp}`,
        `  Scratchpad → ${sp}`,
        `  Subagents → ${ss}`,
      ];
      return lines.join('\n');
    },
    onPlugin: async (args) => {
      const parsed = args.length === 0 ? [] : args.split(/\s+/).filter(Boolean);
      const result = await runPluginManagementCommand(parsed, {
        config,
        configPath: wpaths.globalConfig,
      });
      if (result.patch) {
        const patch = result.patch as never as Partial<Config>;
        config = patchConfig(config, patch);
        configStore.update(patch);
      }
      if (result.restartRequired && result.code === 0) {
        return `${result.message}\nRestart WrongStack to load or unload plugin code in this session.`;
      }
      return result.message;
    },
    onContextLimit: (tokens?: number) => {
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
        effectiveMaxContextRef.current = tokens;
        context.provider.capabilities.maxContext = tokens;
        context.meta['effectiveMaxContext'] = tokens;
        autoCompactor?.setMaxContext(tokens);
        events.emit('ctx.max_context', {
          sessionId: context.session.id,
          providerId: config.provider,
          modelId: context.model,
          maxContext: tokens,
        });
        eventWiring.setEffectiveMaxContext(tokens);
      }
      return effectiveMaxContextRef.current;
    },
    onMcp: async (args) => {
      const parsed = parseMcpArgs(args);
      if (!parsed) {
        return [
          'Usage: /mcp [list|add <name>|remove <name>|enable <name>|disable <name>|restart <name>]',
          'Run `/mcp` without args to see available servers.',
        ].join('\n');
      }
      return runMcpManagementCommand(parsed, {
        config,
        configPath: wpaths.globalConfig,
        mcpRegistry,
        allServerPresets: allServers(),
      });
    },
    mcpRegistry,
    mcpStatus: () =>
      mcpRegistry.describe().map((s) => ({
        name: s.name,
        state: s.state,
        enabled: s.enabled,
        toolCount: s.toolCount,
      })),
    onYolo: setYoloMode,
    onNextPredict: (setTo?: boolean) => {
      if (setTo !== undefined) {
        nextPredictEnabled = setTo;
        config = patchConfig(config, { nextPrediction: setTo });
        return setTo;
      }
      return nextPredictEnabled;
    },
    onSuggestions: (suggestions?: string[]) => {
      if (suggestions !== undefined) {
        currentSuggestions = suggestions;
        // Also sync to the shared module-level store so /next works
        // reliably across all surfaces (REPL, TUI, WebUI).
        setSuggestions(suggestions);
      }
      // Read from shared store first for consistency across surfaces
      const shared = getSuggestions();
      return shared.length > 0 ? shared : currentSuggestions;
    },
    onAutonomy: (setTo?) => {
      if (setTo !== undefined) {
        autonomyMode = setTo;
        // Mirror into the early ref so the system-prompt contributor
        // (constructed at line ~185) sees the current mode at build time.
        autonomyModeRef.current = setTo;
        return setTo;
      }
      return autonomyMode;
    },
    onEternalStart: (mode?: import('./slash-commands/autonomy.js').AutonomyMode) => {
      // Lazy-instantiate so the engine doesn't exist (and doesn't hold
      // references to the agent) until the user opts in. Re-uses an
      // existing instance if the user stops then restarts within the
      // same session — state lives on disk anyway.
      const effectiveMode = mode ?? 'eternal';
      if (effectiveMode === 'eternal-parallel') {
        if (!parallelEngine) {
          const parallelOptions: ConstructorParameters<typeof ParallelEternalEngine>[0] & {
            onStage?: ((stage: AutonomyStage) => void) | undefined;
          } = {
            agent,
            projectRoot,
            compactor: container.resolve(TOKENS.Compactor) as import('@wrongstack/core').Compactor,
            maxContextTokens: effectiveMaxContextRef.current > 0 ? effectiveMaxContextRef.current : undefined,
            onIteration: broadcastEternalIteration,
            onStage: broadcastAutonomyStage,
            // Real per-role factory: each dispatched slot runs as a fresh,
            // isolated agent with the role's filtered tools + persona prompt
            // (instead of sharing the leader agent's Context).
            subagentFactory: multiAgentHost.makeSubagentFactory(config),
            events,
          };
          parallelEngine = new ParallelEternalEngine({ ...parallelOptions, logger });
        }
        void parallelEngine.prime?.();
      } else {
        if (!eternalEngine) {
          eternalEngine = new EternalAutonomyEngine({
            agent,
            projectRoot,
            compactor: container.resolve(TOKENS.Compactor) as import('@wrongstack/core').Compactor,
            maxContextTokens: effectiveMaxContextRef.current > 0 ? effectiveMaxContextRef.current : undefined,
            onIteration: broadcastEternalIteration,
            onStage: broadcastAutonomyStage,
            brain,
            events,
            logger,
          });
        }
        void eternalEngine.prime();
      }
    },
    onEternalStop: () => {
      eternalEngine?.stop();
      parallelEngine?.stop();
    },
    onExit: () => {
      for (const teardown of teardownHandlers) teardown();
      teardownHandlers.length = 0;
      void mcpRegistry.stopAll();
      multiAgentHost
        .dispose()
        .catch((err: unknown) =>
          logger.warn(
            `multiAgentHost.dispose() failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    onBeforeExit: async () => {
      // Check for uncommitted changes directly
      const cwd = projectRoot;

      const statusResult = await new Promise<{ stdout: string; code: number }>(
        (resolve, reject) => {
          const child = spawn('git', ['status', '--porcelain'], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: AbortSignal.timeout(5000),
            windowsHide: true,
          });
          let stdout = '';
          child.stdout?.on('data', (d) => {
            stdout += d;
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
        },
      );

      if (statusResult.stdout.trim().length > 0) {
        const lines = statusResult.stdout.split('\n').filter(Boolean);
        return {
          abort: true, // signals there are uncommitted changes (used only for the message)
          message: `⚠ ${color.yellow(`${lines.length} uncommitted change${lines.length > 1 ? 's' : ''}`)} — session ended without commit`,
        };
      }
      return undefined;
    },
    onClear: () => {
      // In TUI mode Ink owns the live area; writing `\x1b[2J` here would
      // fight Ink's cursor math and leave the status bar smeared. The
      // context/memory reset inside /clear is enough — the user can
      // scroll up to see prior turns in scrollback. In REPL we erase
      // the visible screen + scrollback (`\x1b[3J`) so the next prompt
      // starts on a fresh terminal.
      if (flags.tui && !flags['no-tui']) return;
      try {
        writeOut('\x1b[2J\x1b[3J\x1b[H');
      } catch {
        // stdout may be closed during shutdown — ignore.
      }
    },
    onNewSession: async () => {
      // TUI-only: signal the TUI to wipe its history entries and reset
      // cumulative fleet/leader stats. This is called from /clear after
      // the session has been cleared on disk so the UI state matches.
      // The TUI runs its own event-listener that dispatches the
      // 'clearHistory' + 'resetContextChip' actions in response.
    },
    onDiag: () => {
      const u = tokenCounter.total();
      const cost = tokenCounter.estimateCost();
      const errSection =
        errorRing.length === 0
          ? []
          : [
              '',
              `${color.bold('Recent errors')} (last ${errorRing.length}):`,
              ...errorRing.map((e) => `  [${e.ts}] ${e.phase} ${e.code} — ${e.message}`),
            ];
      // P2 #5 Phase 4: side-effect audit timeline from the in-memory list.
      const sideEffects = context.sideEffects ?? [];
      const sideEffectSection =
        sideEffects.length === 0
          ? []
          : [
              '',
              `${color.bold('Side effects')} (last ${sideEffects.length}):`,
              ...sideEffects.slice(-20).map((se) => {
                const time = se.ts.slice(11, 19);
                const detail = se.outcome ? ` → ${se.outcome}` : '';
                return `  ${time}  ${se.toolName.padEnd(8)} ${se.risk.padEnd(7)} ${se.input['command'] ?? se.input['url'] ?? se.input['packages'] ?? JSON.stringify(se.input).slice(0, 60)}${detail}`;
              }),
            ];
      // Read current provider from the ConfigStore so /diag always shows
      // the live value, even if /model swapped it mid-session (L1-B).
      const liveCfg = configStore.get();
      // Surface the wire family on its own line so the user can tell whether
      // the active provider id is a real catalog entry (e.g. "anthropic") or
      // a saved-config alias that resolves to a catalog family (e.g. the
      // user picks "minimax-coding-plan" but the wire family is "anthropic").
      // Fix for issue #16: distinguish provider id from wire family in /diag.
      // Mirrors the banner layout (provider / family on separate lines) and
      // reads from the same ProviderConfig.family field the banner uses via
      // banneredFamily in execution.ts, so the two surfaces never disagree.
      // The runtime Provider interface does not expose family, so we read
      // it from the saved config which is the same source of truth the
      // banner reads at boot.
      const liveFamily = liveCfg.providers?.[liveCfg.provider]?.family;
      return [
        `${color.bold('WrongStack diag')}`,
        `  provider:     ${liveCfg.provider} / ${context.model}`,
        liveFamily ? `  family:       ${liveFamily}` : null,
        `  projectRoot:  ${projectRoot}`,
        `  tokens:       in ${u.input}  out ${u.output}  cacheR ${u.cacheRead ?? 0}`,
        `  cost:         ${cost.total.toFixed(4)}`,
        `  tools:        ${toolRegistry.list().length}`,
        `  mcpServers:   ${mcpRegistry.list().length}`,
        ...errSection,
        ...sideEffectSection,
      ]
        .filter((line): line is string => line !== null)
        .join('\n');
    },
    onStats: () => stats.format(),
    generateCommitMessage: async (diff: string) => {
      return generateCommitMessageWithLLM(diff, {
        provider: context.provider as CommitLLMProvider,
        model: context.model,
      });
    },
    onDispatchClassify: makeProviderClassifier(
      context.provider as CommitLLMProvider,
      context.model,
    ),
    onSddParallelRun: async (opts) => {
      const sdd = await import('./slash-commands/sdd.js');
      const tracker = sdd.getTaskTracker();
      const builder = sdd.getActiveBuilder();
      if (!tracker || !builder) {
        return 'No active SDD session with tasks. Use /sdd new to start one.';
      }
      const session = builder.getSession();
      if (session.phase !== 'executing' && session.phase !== 'task_review') {
        return `Cannot run parallel in phase "${session.phase}". Use /sdd approve first.`;
      }
      const graphId = sdd.getTaskGraphId();
      const graphStore = new (await import('@wrongstack/sdd')).TaskGraphStore({
        baseDir: wpaths.projectTaskGraphs,
      });
      const graph = graphId ? await graphStore.load(graphId) : null;
      if (!graph) {
        return 'No task graph found for the current SDD session.';
      }
      const core = await import('@wrongstack/core');
      const sddApi = await import('@wrongstack/sdd');
      // Resume safety (orphaned in_progress reset) is handled inside startSddRun.

      // Per-task git-worktree isolation: each parallel agent works in its own
      // checkout so they never collide on the same files. Gated to git repos;
      // disable with WRONGSTACK_SDD_WORKTREES=0 (then tasks share the tree).
      let worktrees: import('@wrongstack/core').WorktreeManager | undefined;
      if (process.env['WRONGSTACK_SDD_WORKTREES'] !== '0') {
        // Async git detection — replaces a synchronous spawnSync that blocked
        // the REPL/event loop during SDD worktree setup. `git` may not be
        // installed (CI, containers) — treat spawn failure as "not a repo"
        // and skip worktree setup rather than aborting the run.
        const inGit = await new Promise<boolean>((resolve) => {
          let resolved = false;
          const settle = (v: boolean): void => {
            if (resolved) return;
            resolved = true;
            resolve(v);
          };
          try {
            const child = spawn('git', ['rev-parse', '--is-inside-work-tree'], {
              cwd: projectRoot,
              env: process.env,
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            });
            const chunks: string[] = [];
            child.stdout?.on('data', (c: Buffer) => chunks.push(c.toString()));
            child.on('error', () => settle(false));
            child.on('close', (code) => settle(code === 0 && chunks.join('').trim() === 'true'));
          } catch {
            settle(false);
          }
        });
        if (inGit) {
          // Clean slate before allocating: sweep orphaned worktrees/branches a
          // prior crashed/abandoned run left behind. Liveness-guarded so it
          // never disturbs a run live in another process.
          await sddApi
            .cleanupStaleSddWorktrees({ projectRoot, boardsDir: wpaths.projectSddBoards })
            .catch(() => undefined);
          worktrees = new core.WorktreeManager({
            projectRoot,
            events,
            sessionId: () => sessionRef.current?.id ?? session.id,
          });
        }
      }

      const boardStore = new sddApi.SddBoardStore({ baseDir: wpaths.projectSddBoards });

      // Completion gate: when a task declares `metadata.verificationCommand`, run
      // it in the task's worktree cwd and only let the task complete on exit 0.
      // No command → no-op (the run's existing guards still apply). Bounded so a
      // hung verifier can't wedge the run. Shared with the standalone WebUI wizard
      // via core.makeCommandVerifier so both surfaces gate identically.
      const verifyTask = sddApi.makeCommandVerifier();

      // Failure supervisor: when a task exhausts its retries, the Brain decides
      // retry/reassign/fail rather than dead-ending. Safe default (no LLM verdict)
      // is a bounded retry, so this only ever helps the run keep moving. The
      // run-level fallback chain (already validated against configured providers)
      // is offered as `reassignModels`, so a `reassign` verdict rotates the worker
      // model on retry.
      // NOTE: `requestLlmVerdict` is intentionally left false here. The CLI brain
      // is wrapped in HumanEscalatingBrainArbiter, so an `ask_human` escalation
      // would BLOCK mid-run on a human prompt and wedge the parallel run. With
      // the default (`fallback: 'continue'`) the policy answers in place — a safe
      // bounded retry — and `reassignModels` still applies when a brain answers
      // `reassign`. (Standalone WebUI, whose brain has no human wrapper, enables
      // it; see sdd-wizard-wiring.ts.)
      const sddSupervisor = new sddApi.SddSupervisor({
        brain,
        reassignModels: core.effectiveFallbackChain(config),
      });

      // Single per-task subagent factory, shared by the run AND the (optional)
      // LLM conflict resolver's isolated turns.
      const sddSubagentFactory = multiAgentHost.makeSubagentFactory(config);

      // Opt-in merge-conflict resolver (default OFF → conservative
      // retry-on-fresh-base then terminal-fail, which never corrupts the base).
      // WRONGSTACK_SDD_CONFLICT_RESOLVER=prefer-incoming|prefer-base|llm.
      // - prefer-*: a blunt one-side rewrite.
      // - llm:      a semantic merge on a fresh read-only-ish isolated turn.
      // The WorktreeManager still rejects any rewrite that leaves markers, and the
      // run re-verifies the integrated base + reverts a regression (when a
      // verifyTask is set), so a bad resolution degrades safely.
      const conflictMode = process.env['WRONGSTACK_SDD_CONFLICT_RESOLVER'];
      const conflictResolver =
        conflictMode === 'prefer-incoming'
          ? sddApi.makePreferSideConflictResolver('incoming')
          : conflictMode === 'prefer-base'
            ? sddApi.makePreferSideConflictResolver('base')
            : conflictMode === 'llm'
              ? sddApi.makeLlmConflictResolver({
                  run: async (prompt: string): Promise<string> => {
                    const r = await sddSubagentFactory({
                      id: `sdd-conflict-${Date.now()}`,
                      role: 'executor',
                      name: 'Conflict Resolver',
                      disabledTools: ['delegate'],
                      // Only returns the resolved text; the core helper writes the
                      // file. Keep it on the read-only capability floor.
                      allowedCapabilities: ['fs.read', 'net.outbound'],
                    });
                    try {
                      const res = await r.agent.run([{ type: 'text', text: prompt }]);
                      return res.finalText ?? '';
                    } finally {
                      await r.dispose?.();
                    }
                  },
                })
              : undefined;

      // Shared run-setup core (also used by the WebUI servers): orphan reset →
      // run → board projector → registry → cross-process control drain.
      const handle = sddApi.startSddRun({
        tracker,
        graph,
        agent,
        projectRoot,
        events,
        sessionId: () => sessionRef.current?.id ?? session.id,
        parallelSlots: opts?.parallelSlots,
        subagentFactory: sddSubagentFactory,
        worktrees,
        boardStore,
        registry: sddRunRegistry,
        verifyTask,
        conflictResolver,
        superviseFailure: sddSupervisor.superviseFailure,
        onProgress: (p: import('@wrongstack/sdd').SddProgress) => {
          renderer.write(
            `  ░ wave ${p.wave + 1} · ${p.completed}/${p.total} tasks · ${p.percent}% done\n`,
          );
        },
      });
      (globalThis as SddParallelRunGlobal).__sddParallelRun = handle.run;
      try {
        const result = await handle.completion;
        const lines = [
          `SDD parallel run complete:`,
          `  ${result.totalWaves} waves · ${result.totalCompleted} done · ${result.totalFailed} failed`,
          `  ${(result.totalDurationMs / 1000).toFixed(1)}s total`,
        ];
        if (result.deadlocked)
          lines.push(color.red('  ⚠ deadlock — tasks blocked by failed tasks.'));
        if (result.stopRequested) lines.push(color.yellow('  ⚡ stopped by user.'));
        return lines.join('\n');
      } finally {
        (globalThis as SddParallelRunGlobal).__sddParallelRun = undefined;
      }
    },
    onSddParallelStop: () => {
      const run = (globalThis as SddParallelRunGlobal).__sddParallelRun;
      run?.stop();
    },
    onSddRetryAllFailed: () => sddRunRegistry.getActive()?.retryAllFailed() ?? 0,
    onSddSplitTask: (taskId, subtasks) => {
      const active = sddRunRegistry.getActive();
      if (!active) return null;
      // Accept a board short id or a full id — resolve short→full via the snapshot.
      const snap = active.snapshot();
      const match = snap.tasks.find((t) => t.id === taskId || t.shortId === taskId);
      const ids = active.splitTask(match?.id ?? taskId, subtasks);
      return ids.length ? ids : null;
    },
    // ── SDD lifecycle: clean worktrees · rollback commits · destroy project ──
    onSddCleanWorktrees: async () => {
      const active = sddRunRegistry.getActive();
      if (active) return active.cleanupWorktrees();
      const sddApi = await import('@wrongstack/sdd');
      const { removed } = await sddApi.cleanupSddWorktrees(projectRoot);
      return removed;
    },
    onSddRollback: async () => {
      const active = sddRunRegistry.getActive();
      if (active) return active.rollback();
      const sddApi = await import('@wrongstack/sdd');
      return sddApi.rollbackSddRunFromDisk({ projectRoot, boardsDir: wpaths.projectSddBoards });
    },
    onSddDestroy: async (destroyOpts) => {
      // Stop any live run first so nothing writes while we delete.
      sddRunRegistry.getActive()?.stop();
      const sddApi = await import('@wrongstack/sdd');
      return sddApi.destroySddProject({
        projectRoot,
        revertMerged: destroyOpts?.revertMerged === true,
        paths: {
          projectSpecs: wpaths.projectSpecs,
          projectTaskGraphs: wpaths.projectTaskGraphs,
          projectSddSession: wpaths.projectSddSession,
          projectSddBoards: wpaths.projectSddBoards,
        },
      });
    },
    onAutoPhaseStart: autoPhaseHost.onAutoPhaseStart,
    onAutoPhasePause: autoPhaseHost.onAutoPhasePause,
    onAutoPhaseResume: autoPhaseHost.onAutoPhaseResume,
    onAutoPhaseStop: autoPhaseHost.onAutoPhaseStop,
    getAutoPhaseRunner: autoPhaseHost.getAutoPhaseRunner,
    onAutoPhaseMoveTask: autoPhaseHost.onAutoPhaseMoveTask,
    onAutoPhaseAssignTask: autoPhaseHost.onAutoPhaseAssignTask,
    onAutoPhaseAddTask: autoPhaseHost.onAutoPhaseAddTask,
    onAutoPhaseRetryTask: autoPhaseHost.onAutoPhaseRetryTask,
    onWorktree: autoPhaseHost.onWorktree,
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
  const runSuperMemorySessionHygiene = setupSuperMemory({
    config,
    pipelines,
    memoryStore,
    logger,
  });
  const disposeIndexing = await setupCodebaseIndexing({
    config,
    context,
    pipelines,
    projectRoot,
    logger,
  });
  process.once('exit', disposeIndexing);

  // Every audit entry is exposed in the picker. Current bundled rows are all
  // toggleable; canDisable=false remains available for future rows that need
  // to be visible but not picker-toggleable.
  const getPluginPickerItems = (): PluginPickerItem[] =>
    PLUGIN_AUDIT_ENTRIES.map((entry) => {
      const configured = (config.plugins ?? []).find((plugin) =>
        typeof plugin === 'string' ? plugin === entry.name : plugin.name === entry.name,
      );
      const enabled = configured
        ? !(typeof configured === 'object' && configured.enabled === false)
        : entry.defaultState === 'active';
      return {
        name: entry.name,
        enabled,
        risk: entry.risk,
        summary: entry.summary,
        lockable: entry.canDisable,
      };
    });

  const togglePluginFromPicker = async (name: string) => {
    const result = await runPluginManagementCommand(['toggle', name], {
      config,
      configPath: wpaths.globalConfig,
    });
    if (result.patch) {
      const patch = result.patch as never as Partial<Config>;
      config = patchConfig(config, patch);
      configStore.update(patch);
    }
    const restartHint =
      result.restartRequired && result.code === 0
        ? ' Restart WrongStack to load or unload plugin code in this session.'
        : '';
    return {
      items: getPluginPickerItems(),
      message: result.code === 0 ? `${result.message}${restartHint}` : undefined,
      error: result.code === 0 ? undefined : result.message,
    };
  };

  const getToolPickerItems = () => {
    const rows = [...toolRegistry.listWithOwner(), ...toolRegistry.listDisabled()];
    return rows.map(({ tool, owner }) => {
      const descMode = getToolDescriptionMode(toolRegistry, tool.name);
      return {
        name: tool.name,
        owner,
        category: tool.category ?? 'Other',
        enabled: !toolRegistry.isDisabled(tool.name),
        mutating: tool.mutating,
        permission: tool.permission,
        descMode: descMode as 'extend' | 'simple',
        description: tool.description,
      };
    });
  };

  // Listen for runtime autoFix changes from the /chimera autoFix slash command.
  evOn('chimera.set_autofix', (payload) => {
    const mode = (payload as { mode?: string })?.mode;
    if (mode && ['off', 'ask', 'auto'].includes(mode)) {
      agent.ctx.meta['chimeraAutoFix'] = mode;
    }
  });

  // Seed agent.ctx.meta from CLI flags before dispatching to execution.
  // The chimera autoFix handler reads from meta first, then falls back to
  // the config file setting. This lets --chimera-auto-fix override the
  // persisted config for the current session.
  if (typeof flags['chimera-auto-fix'] === 'string') {
    const v = (flags['chimera-auto-fix'] as string).toLowerCase();
    if (v === 'off' || v === 'ask' || v === 'auto') {
      agent.ctx.meta['chimeraAutoFix'] = v;
    }
  }

  // Dispatch to execution phase — single-shot, TUI, REPL, or WebUI.
  const savedProviderCfg = config.providers?.[config.provider];
  return execute(toExecuteDeps({
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
    needsSetup,
  },
  provider: {
    sddSubagentFactory: multiAgentHost.makeSubagentFactory(config),
    modelsRegistry,
    savedProviderCfg: savedProviderCfg as import('@wrongstack/core').ProviderConfig | undefined,
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
      globalConfigPath: wpaths.globalConfig,
    }),
    onPanelOpen,
  },
  controllers: {
    interruptController,
    enhanceController,
    getEnhancerReasoning: () => gatedEnhancerReasoning(activeReasoningConfig),
    // Build an ephemeral provider for retrying a failed refinement on another
    // model — reuses the same non-persisting builder as the fallback chain, so
    // the session provider/model is never mutated.
    buildEnhancerProvider: async (providerId: string, _modelId: string) => {
      // The provider only needs to reach `providerId`'s API — the specific
      // model is passed to `enhanceUserPrompt` directly, not baked into the
      // Provider — so `_modelId` is accepted for interface symmetry but unused.
      try {
        return buildProviderForId(providerId);
      } catch {
        return undefined;
      }
    },
    // Resolve the one-key "retry with another model" offer against the LIVE
    // provider/model so the active model is never offered as its own fallback.
    getEnhanceFallbackRef: () =>
      resolveEnhanceFallbackRef({
        ...configRef.current,
        provider: context.provider.id,
        model: context.model,
      }),
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    saveStatuslineHiddenItems,
    getYolo: setYoloMode,
    onYolo: setYoloMode,
    getAutonomy: () => autonomyMode,
    onAutonomy: (setTo?) => {
      if (setTo !== undefined) {
        autonomyMode = setTo;
        return setTo;
      }
      return autonomyMode;
    },
    getNextPredict: () => nextPredictEnabled,
    applyLiveSettings: (s) => {
      // Apply `/settings` changes to the RUNNING session. Persistence already
      // happened in saveSettings; this only flips live runtime state via the
      // same setters the dedicated slash commands use. Best-effort — a failed
      // live-apply must not surface as a settings-save error.
      //
      // Intentionally NOT applied live:
      //  - `mode` (default autonomy) → only sets the default for next sessions.
      //  - boot-only features (MCP/plugins/memory/skills/modelsRegistry/
      //    tokenSaving/indexOnStart) and `contextStrategy` → need a restart;
      //    the TUI shows a "next session" hint for those instead.
      try {
        if (s.yolo !== undefined) {
          container.resolve(TOKENS.PermissionPolicy).setYolo?.(s.yolo);
          config = patchConfig(config, { yolo: s.yolo });
        }
        if (s.nextPrediction !== undefined) {
          nextPredictEnabled = s.nextPrediction;
          config = patchConfig(config, { nextPrediction: s.nextPrediction });
        }
        if (s.enhanceEnabled !== undefined) {
          enhanceController?.setEnabled(s.enhanceEnabled);
        }
        if (s.maxIterations !== undefined) {
          // Takes effect on the next agent.run (the loop reads this per run).
          agent.maxIterations = s.maxIterations;
        }
        if (s.logLevel !== undefined) {
          // Mutates the root logger; new child loggers pick this up. The agent's
          // existing child logger keeps its boot level — acceptable trade-off.
          container.resolve(TOKENS.Logger).level = s.logLevel as LogLevel;
        }
        if (s.auditLevel !== undefined) {
          sessionBridge.setAuditLevel(s.auditLevel as AuditLevel);
        }
        if (s.contextAutoCompact !== undefined) {
          autoCompactor?.setEnabled(s.contextAutoCompact);
        }
        if (s.maxConcurrent !== undefined && s.maxConcurrent > 0) {
          multiAgentHost.setMaxConcurrent(s.maxConcurrent);
          events.emit('concurrency.changed', {
            sessionId: sessionRef.current?.id ?? session.id,
            n: s.maxConcurrent,
          });
          config = patchConfig(config, { maxConcurrent: s.maxConcurrent });
        }
        if (s.restrictFsToRoot !== undefined || s.allowOutsideProjectRoot !== undefined) {
          // Single source of truth for the inverse pair — see
          // deriveFsAccessPair in settings-menu.ts for the precedence
          // rules. Without this, the picker and the /settings slash
          // command would each maintain their own copy of the math
          // and could disagree on contradictory inputs.
          const fsAccess = deriveFsAccessPair(s);
          if (fsAccess) {
            // Toggle the live filesystem-access scope on the leader
            // context so file tools immediately honor the new boundary.
            // Subagents spawned afterwards read the patched config below.
            context.allowOutsideProjectRoot = fsAccess.allowOutsideProjectRoot;
            // Dual-write both config keys in sync (inverses): the new
            // canonical features.allowOutsideProjectRoot plus the legacy
            // tools.restrictToProjectRoot, so older readers don't break.
            config = patchConfig(config, {
              features: {
                ...config.features,
                allowOutsideProjectRoot: fsAccess.allowOutsideProjectRoot,
              },
              tools: {
                ...config.tools,
                restrictToProjectRoot: fsAccess.restrictToProjectRoot,
              },
            });
          }
        }
      } catch {
        // Live-apply is best-effort; the persisted config is the source of truth.
      }
    },
    onCountdownTick: (remaining) => {
      events.emit('countdown.tick', { sessionId: sessionRef.current?.id ?? session.id, remaining });
      return false;
    },
  },
  picker: {
    getPluginItems: getPluginPickerItems,
    onPluginToggle: togglePluginFromPicker,
    getMcpServers: () => {
      const servers = (config.mcpServers ?? {}) as Record<string, { name: string; transport: string; enabled?: boolean; description?: string; lazy?: boolean }>;
      const liveStatus = mcpRegistry.list();
      const liveMap = new Map(liveStatus.map((s) => [s.name, s]));
      return Object.entries(servers).map(([name, cfg]) => {
        const live = liveMap.get(name);
        return {
          name,
          enabled: cfg.enabled !== false,
          status: live ? live.state : 'stopped',
          transport: cfg.transport ?? 'stdio',
          description: cfg.description,
          toolCount: live?.toolCount ?? 0,
          lazy: cfg.lazy,
        };
      });
    },
    onMcpToggle: async (name: string) => {
      const { enableMcp, disableMcp, listMcp } = await import('@wrongstack/mcp');
      const deps = { configPath: wpaths.globalConfig, registry: mcpRegistry, presets: allServers() };
      // Read fresh state from the live config file (enableMcp/disableMcp
      // wrote to it), then determine toggle direction from the registry.
      const live = mcpRegistry.list().find((s) => s.name === name);
      const isCurrentlyEnabled = live !== undefined && live.state !== 'idle';
      const result = isCurrentlyEnabled
        ? await disableMcp(name, deps)
        : await enableMcp(name, deps);
      const items = await listMcp(deps);
      return {
        items: items.map((s) => ({ name: s.name, enabled: s.enabled, status: s.status, transport: s.transport, description: s.description, toolCount: s.tools.length, lazy: s.lazy })),
        message: result.ok ? (result.server ? `${result.server.status === 'connected' ? '●' : '○'} ${name}` : result.message) : undefined,
        error: result.ok ? undefined : result.message,
      };
    },
    onMcpRestart: async (name: string) => {
      const { listMcp } = await import('@wrongstack/mcp');
      const deps = { configPath: wpaths.globalConfig, registry: mcpRegistry, presets: allServers() };
      try {
        await mcpRegistry.restart(name);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const items = await listMcp(deps);
        return { items: items.map((s) => ({ name: s.name, enabled: s.enabled, status: s.status, transport: s.transport, description: s.description, toolCount: s.tools.length, lazy: s.lazy })), message: undefined, error: message };
      }
      const items = await listMcp(deps);
      return { items: items.map((s) => ({ name: s.name, enabled: s.enabled, status: s.status, transport: s.transport, description: s.description, toolCount: s.tools.length, lazy: s.lazy })), message: `Restarted "${name}".`, error: undefined };
    },
    getToolsItems: getToolPickerItems,
    onToolToggle: async (name: string) => {
      const disabled = new Set(config.tools?.disabledTools ?? []);
      const isCurrentlyDisabled = toolRegistry.isDisabled(name);
      if (isCurrentlyDisabled) {
        toolRegistry.enable(name);
        disabled.delete(name);
      } else {
        toolRegistry.disable(name);
        disabled.add(name);
      }
      const nextTools = { ...(config.tools ?? {}), disabledTools: Array.from(disabled) };
      config = patchConfig(config, { tools: nextTools });
      configStore.update({ tools: nextTools });
      return {
        items: getToolPickerItems(),
        message: isCurrentlyDisabled ? `Enabled "${name}".` : `Disabled "${name}".`,
        error: undefined,
      };
    },
    getBrainData: () => {
      const ceiling = (brainSettings?.maxAutoRisk ?? 'medium') as 'off' | 'low' | 'medium' | 'high' | 'all';
      const log = brainLog.slice(-20).map((entry: { kind: string; question: string; outcome: string; at: number }) => ({
        kind: entry.kind,
        question: entry.question,
        outcome: entry.outcome,
        age: typeof entry.at === 'number' ? (() => { const s = Math.max(0, Math.round((Date.now() - entry.at) / 1000)); if (s < 60) return `${s}s`; if (s < 3600) return `${Math.round(s / 60)}m`; return `${Math.round(s / 3600)}h`; })() : '',
      }));
      return { riskLevel: ceiling, log };
    },
    onBrainRiskLevel: (level: 'off' | 'low' | 'medium' | 'high' | 'all') => {
      if (!brainSettings) return 'Brain settings not available.';
      brainSettings.maxAutoRisk = level as import('@wrongstack/core').BrainAutoRisk;
      return undefined;
    },
    brain,
    brainSettings,
    brainRuntime,
    getBrainLog: () => brainLog,
  },
  lifecycles: {
    onSuggestionsParsed: (suggestions) => {
      // Always update — null means "no suggestions found", which must
      // clear the list so the auto-proceed loop doesn't get stuck
      // re-feeding stale suggestions.
      currentSuggestions = suggestions ?? [];
      setSuggestions(suggestions ?? []);
    },
    getSuggestions: () => {
      // Read from shared store first for cross-surface consistency
      const shared = getSuggestions();
      return shared.length > 0 ? shared : currentSuggestions;
    },
    autoProceedDelayMs:
      ((config.autonomy as Record<string, unknown> | undefined)?.autoProceedDelayMs as number) ??
      45_000,
    autoProceedMaxIterations:
      ((config.autonomy as Record<string, unknown> | undefined)
        ?.autoProceedMaxIterations as number) ?? 50,
    onValidateAutoProceed: async (suggestion, lastOutput) => {
      try {
        const resp = await context.provider.complete(
          {
            model: context.model,
            system: [
              {
                type: 'text',
                text: 'You are a safety validator for an autonomous coding agent. Your ONLY job is to decide whether the agent should auto-proceed with a suggested next step, or whether a human should review first. Reply with exactly one word: YES or NO.',
              },
            ],
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `The autonomous agent just completed a turn and generated this top-ranked next-step suggestion:\n\n"${suggestion}"\n\n${lastOutput ? `Recent agent output:\n${lastOutput.slice(0, 500)}\n\n` : ''}Should the agent auto-proceed with this suggestion, or should a human review first?\n\nReply YES to auto-proceed, NO to wait for human input.`,
                  },
                ],
              },
            ],
            maxTokens: 5,
            temperature: 0,
          },
          { signal: AbortSignal.timeout(10_000) },
        );
        const text = resp.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('')
          .trim()
          .toUpperCase();
        return text.startsWith('YES');
      } catch {
        // On any error (network, provider, timeout), err on the side
        // of safety — do NOT auto-proceed.
        return false;
      }
    },
    getEternalEngine: () => eternalEngine,
    getParallelEngine: () => parallelEngine,
    getSddRun: () => sddRunRegistry.getActive(),
    onSddLifecycle: async (op, lcOpts) => {
      const active = sddRunRegistry.getActive();
      if (op === 'destroy') active?.stop();
      else if (active?.isRunning()) {
        return { op, ok: false, reason: 'Stop the run first (Ctrl+C), then retry.' };
      }
      const sddApi = await import('@wrongstack/sdd');
      return sddApi.applySddLifecycle(op, {
        projectRoot,
        revertMerged: lcOpts?.revertMerged === true,
        paths: {
          projectSpecs: wpaths.projectSpecs,
          projectTaskGraphs: wpaths.projectTaskGraphs,
          projectSddSession: wpaths.projectSddSession,
          projectSddBoards: wpaths.projectSddBoards,
        },
      });
    },
    subscribeEternalIteration: (fn) => {
      eternalListeners.add(fn);
      return () => eternalListeners.delete(fn);
    },
    subscribeEternalStage: (fn) => {
      stageListeners.add(fn);
      return () => stageListeners.delete(fn);
    },
    onDestroy: () => {
      void runSuperMemorySessionHygiene().catch((err) => {
        logger.warn('super-memory session hygiene failed', { error: String(err) });
      });
      teardownHandlers.forEach((fn) => {
        fn();
      });
      stats.destroy(events);
    },
  },
}));
}

/**
 * Prompt the user about an abandoned session. The lockfile lifecycle
 * guarantees we only get here when the previous instance died without
 * writing `session_end` AND there's real work on disk (≥1 message).
 *
 * `--recover` short-circuits to "resume" without asking; piped/non-TTY
 * input degrades to the same — the alternative is hanging on stdin or
 * forcing the user to remember a flag they never typed.
 */
// promptRecovery lives in `cli-recovery-prompt.ts` (extracted so it can be
// unit-tested with a fake ReadlineInputReader + TerminalRenderer stub
// without spinning up the whole CLI). Imported at the top of this file.

// isMain detection + bounded exit-on-both-success-and-failure live in
// `index.ts` (the real entry point). This module exports `main` for
// library consumers; `index.ts` calls `runAsMain(main)` once.
//
// Issue #29 (cli-main 7-PR refactor) — final state:
//   - All seven PRs (0 through 7) landed.
//   - The boot sequence is decomposed into focused helpers
//     under `packages/cli/src/boot/` (see the file header for
//     the full module map).
//   - This file is the orchestrator only. Adding a new boot
//     phase means adding a new `boot/<phase>.ts` and calling
//     it from `main()` — do not inline it here.
