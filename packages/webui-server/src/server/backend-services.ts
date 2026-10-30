/**
 * Post-context backend service construction for the standalone WebUI server.
 *
 * Phase 1c of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` previously inlined ~400 lines of construction that runs
 * AFTER `context` exists: the agent pipelines + collab middleware, the
 * strategy compactor + auto-compaction middleware, the tool executor +
 * agent, the tiered Brain + monitor, and the per-feature WebSocket
 * handlers (Goal, specs, SDD board/wizard, worktree, terminal, collab).
 *
 * All of that moves into `createAgentServices()`. The pre-context
 * registries/stores (modelsRegistry, container, toolRegistry, session,
 * tokenCounter, …) stay in `startWebUI` because they are interleaved with
 * the `opts.services?` injection contract the CLI's embedded server
 * relies on; lifting them would restructure that contract, which is a
 * separate, higher-risk task.
 *
 * The factory is pure construction — no behaviour change. It returns a
 * typed `AgentServices` object plus the `updateAutoCompactionMaxContext`
 * closure (which needs the live `context`, `autoCompactor`, and
 * `modelCapabilitiesRef` it just built).
 */

import { TOKENS } from '@wrongstack/contracts/kernel';
import { DEFAULT_TOOLS_CONFIG, resolveContextWindowPolicy } from '@wrongstack/contracts/types';
import {
  CollaborationBus as CollaborationBusCtor,
  collabInjectMiddleware,
  collabPauseMiddleware,
} from '@wrongstack/coordination';
import { Agent, createEventUserInputAwaiter, isUnattendedAutonomy } from '@wrongstack/core/agent';
import { installDesignStudioMiddleware, installDesignTurnGate } from '@wrongstack/core/design';
import type { AutoCompactionMiddleware } from '@wrongstack/core/execution';
import {
  AutoCompactionMiddleware as AutoCompactionMiddlewareCtor,
  createStrategyCompactor,
  ToolExecutor,
} from '@wrongstack/core/execution';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import {
  CONTEXT_MANAGER_TOOL_NAME,
  createContextManagerTool,
} from '@wrongstack/core/infrastructure';
import {
  createLocalSkillSuggestionSetup,
  createSkillMentionMiddleware,
  createSkillSuggestionSetup,
} from '@wrongstack/core/skills';
import type { ConsolidatorSage } from '@wrongstack/core/storage';
import { SessionMemoryConsolidator } from '@wrongstack/core/storage';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';
import { estimateRequestTokensCalibrated } from '@wrongstack/core/utils';
import { makeLightSubagentFactory } from '@wrongstack/runtime';
import {
  createMemoryCuratorLlmCall,
  getSageService,
  type LlmCallFn,
  setupSage,
} from '@wrongstack/sage';
import { installVibeProtocol } from '@wrongstack/sdd';
import {
  createWrongTraceHookPair,
  persistWrongTraceGateCounters,
  recordGateDecision,
  snapshotGateDecisions,
} from '@wrongstack/wrongtrace';
import { createBackendBrain } from './backend-brain.js';
import type { AgentServices, AgentServicesInput } from './backend-services-types.js';
import { setupWebUICodebaseIndexing } from './codebase-indexing.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { installConversationFallback } from './conversation-fallback.js';
import { createSessionAgentManager } from './create-session-agent-manager.js';
import { discoverMailboxBridgeForWebui } from './discover-mailbox-bridge.js';
import { GoalWebSocketHandler } from './goal-ws-handler.js';
import { createKanbanRunMirror } from './kanban-run-mirror.js';
import { createMaxContextUpdater, positiveWindow } from './max-context-updater.js';
import { resolveProviderModelMetadata } from './model-catalog.js';
import { buildSavedProvider } from './saved-provider.js';
import { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import { buildSddWizardDeps } from './sdd-wizard-wiring.js';
import { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { SpecsWebSocketHandler } from './specs-ws-handler.js';
import { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { errMessage } from './ws-utils.js';

/**
 * Build the post-context agent services: pipelines + middleware, compaction,
 * tool executor + agent, Brain, and the per-feature WebSocket handlers.
 *
 * Returns everything `startWebUI` needs to wire routes + the dispatcher.
 * The `updateAutoCompactionMaxContext` closure captures the live
 * `autoCompactor` / `modelCapabilitiesRef` it built.
 */
export async function createAgentServices(input: AgentServicesInput): Promise<AgentServices> {
  const {
    config,
    wpaths,
    logger,
    projectRoot,
    workingDir,
    context,
    provider,
    container,
    toolRegistry,
    providerRegistry,
    modelsRegistry,
    events,
    memoryStore,
    modelCapabilitiesRef,
  } = input;

  // Collaboration bus — process-singleton pause/resume signal. The
  // middleware below hooks it into the toolCall pipeline so a
  // `controller` participant can halt the agent before the next tool
  // call (Phase 3 of idea #13). The same bus instance is shared with
  // the CollaborationWebSocketHandler so client pause/resume requests
  // are routed to the kernel.
  const collabBus = new CollaborationBusCtor();
  const pipelines = input.pipelines;
  // Phase 4 — collab-inject. Install it first, then prepend collab-pause
  // ahead of it so a controller can pause + inject before the next tool result
  // flows through the pipeline.
  const collabInject = collabInjectMiddleware(collabBus, { logger });
  pipelines.toolCall.prepend(collabInject);
  const collabPause = collabPauseMiddleware(collabBus, { logger });
  pipelines.toolCall.prepend(collabPause);
  // Design Studio — per-turn UI-intent detection + kit-menu injection.
  installDesignStudioMiddleware({ pipelines, ctx: context });
  // VIBE protocol — synthesize/coder input contract + final-response audit.
  // Same middleware the CLI/TUI lifecycle installs, so standalone WebUI
  // honors `[VIBE]` the same way as `wstack --webui`.
  installVibeProtocol(pipelines);
  // Shared CLI/WebUI wiring: tool-call inject, opt-in turn inject, domain terms,
  // context monitor, session-end commit extractor, and throttled hygiene teardown.
  let memoryCuratorLlm: LlmCallFn | undefined;
  const runSageSessionHygiene = setupSage({
    config,
    pipelines,
    memoryStore,
    logger,
    events,
    getSessionId: () => input.sessionGetter().id,
    projectRoot,
    // Assigned once the agent exists (its provider chain wraps the calls).
    getLlmCall: () => memoryCuratorLlm,
  });
  // CLI parity (`prepareRuntimeDispatch`): same setup, same opt-in gate, same
  // position after SAGE on the request pipeline.
  const skillSuggestion = createSkillSuggestionSetup({
    config,
    skillLoader: config.features.skills ? input.skillLoader : undefined,
    logger,
    getSessionId: () => input.sessionGetter().id,
    getAvailableToolNames: () =>
      (context.catalogTools.length > 0 ? context.catalogTools : context.tools).map(
        (tool) => tool.name,
      ),
  });
  if (skillSuggestion) pipelines.request.use(skillSuggestion);
  const localSkillSuggestion = createLocalSkillSuggestionSetup({
    config,
    skillLoader: input.skillLoader,
    logger,
    getAvailableToolNames: () =>
      (context.catalogTools.length > 0 ? context.catalogTools : context.tools).map(
        (tool) => tool.name,
      ),
  });
  if (localSkillSuggestion) pipelines.request.use(localSkillSuggestion);
  if (config.features.skills && input.skillLoader)
    pipelines.request.use(createSkillMentionMiddleware(input.skillLoader));
  const codebaseIndexing = setupWebUICodebaseIndexing({
    config,
    context,
    projectRoot,
    logger,
    events,
  });
  // Compactor — honors config.context.strategy ('hybrid' default, lossless
  // rules; 'intelligent'/'selective' resolve their provider from ctx at
  // compact()-time). eliseThreshold is a TOKEN COUNT (not a fraction).
  const compactor = createStrategyCompactor({
    strategy: config.context?.strategy,
    preserveK: config.context?.preserveK ?? 10,
    eliseThreshold: config.context?.eliseThreshold ?? 2000,
    // Match the CLI/TUI runtime: keep corrections, errors and decisions
    // verbatim while collapsing routine assistant chatter/tool protocol.
    // Without this WebUI's hybrid strategy builds an ever-growing lossless
    // digest and eventually relies on blunt emergency head/tail trimming.
    smart: true,
    summarizerModel: config.context?.summarizerModel,
    llmSelector: config.context?.llmSelector,
    getSystemOneJudge: () =>
      resolveTypeSafeJudge({ config: input.config, feature: 'compaction', logger }),
  });

  // `context_manager` — registered HERE, not in `registerCanonicalHostTools`.
  //
  // The CLI passes `contextTool` into that canonical call because it builds its
  // compactor first. This server can't: `createPreContextServices` builds the
  // tool registry (start-webui.ts) long before `createAgentServices` builds the
  // compactor above, so the canonical call runs with no compactor to hand it.
  // The result was a surface gap — the model could self-manage its context
  // under `wstack` but not in the standalone server, which boots through this
  // path.
  //
  // `registerDefault` matches the canonical registration exactly (no-op if some
  // other owner already claimed the name), and `exposeToProvider` mirrors the
  // `directNames.add(contextTool.name)` branch — it self-cancels when the tier
  // is 'off', because that leaves `_providerToolNames` undefined and the whole
  // catalog is already exposed.
  //
  // The disabled check is NOT redundant: `applyDisabled` ran during the
  // canonical call, and `ToolRegistry.disable()` ignores names that aren't
  // registered yet. Registering afterwards would otherwise resurrect a tool the
  // operator turned off in `tools.disabledTools`.
  if (!(config.tools?.disabledTools ?? []).includes(CONTEXT_MANAGER_TOOL_NAME)) {
    toolRegistry.registerDefault(createContextManagerTool({ compactor }));
    toolRegistry.exposeToProvider(CONTEXT_MANAGER_TOOL_NAME);
  }

  // Per-model catalog facts FIRST — mirrors the CLI's resolveRuntimeMaxContext
  // chain. `config.context.effectiveMaxContext` is a single model-agnostic
  // number; consulting it before the catalog pins every model to one window
  // (a stale 128k there collapsed 1M-window models across the whole config).
  // It stays as the fallback for models nothing published a window for.
  let effectiveMaxContext = 0;
  try {
    const m = await resolveProviderModelMetadata(
      modelsRegistry,
      config.provider,
      context.model,
      config.providers?.[config.provider],
    );
    effectiveMaxContext = positiveWindow(m?.capabilities?.maxContext) ?? 0;
  } catch {
    // best-effort: fall through to the configured value / provider capability
  }
  if (!effectiveMaxContext) {
    effectiveMaxContext = positiveWindow(config.context?.effectiveMaxContext) ?? 0;
  }
  if (!effectiveMaxContext) effectiveMaxContext = provider.capabilities.maxContext;

  const initialContextPolicy = resolveContextWindowPolicy(
    config.context,
    undefined,
    effectiveMaxContext,
  );
  // Auto-compaction
  let autoCompactor: AutoCompactionMiddleware | undefined;
  if (config.context?.autoCompact !== false) {
    autoCompactor = new AutoCompactionMiddlewareCtor(
      compactor,
      effectiveMaxContext,
      (ctx) =>
        estimateRequestTokensCalibrated(
          ctx.messages,
          ctx.systemPrompt,
          ctx.tools ?? [],
          `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
        ).total,
      {
        warn: initialContextPolicy.thresholds.warn,
        soft: initialContextPolicy.thresholds.soft,
        hard: initialContextPolicy.thresholds.hard,
      },
      {
        events,
        aggressiveOn: initialContextPolicy.aggressiveOn,
        policyProvider: (ctx) => {
          const policy = ctx.meta['contextWindowPolicy'];
          return policy && typeof policy === 'object'
            ? (policy as ReturnType<typeof resolveContextWindowPolicy>)
            : initialContextPolicy;
        },
      },
    );
    pipelines.contextWindow.use({ name: 'AutoCompaction', handler: autoCompactor.handler() });
  }

  /** Refresh AutoCompactionMiddleware denominator when the active model changes. */
  const updateAutoCompactionMaxContext = createMaxContextUpdater({
    config,
    getConfig: () => input.config,
    context,
    modelsRegistry,
    events,
    logger,
    modelCapabilitiesRef,
    autoCompactor,
  });

  // Agent
  // A form nobody answers while the tab runs eternal / parallel autonomy gets
  // no answer after the approval wait instead of holding the run.
  context.userInputAwaiter ??= createEventUserInputAwaiter(events, {
    isUnattended: (meta) => isUnattendedAutonomy(meta?.['autonomy']),
  });
  const secretScrubber = container.resolve(TOKENS.SecretScrubber);
  const renderer = container.has(TOKENS.Renderer) ? container.resolve(TOKENS.Renderer) : undefined;
  const permissionPolicy = container.resolve(TOKENS.PermissionPolicy);
  // WrongTrace guardrail: dedicated lock-gate runner for the standalone
  // server, mirroring the CLI's lifecycle-plugins.ts registration (same
  // events, matcher, owner id). Owner identity = THIS process's active
  // session id — startWebUI is its own process, never a copied CLI-leader
  // closure; when the CLI hosts WebUI in-process, dispatch-webui routes
  // through the CLI agent and its already-gated executor instead.
  const wrongTraceHookRegistry = new HookRegistry();
  // Per-runner pair: pre/post share one lock set, so this server's release
  // can never free an SDD-wizard worker's active claim (see hooks.ts
  // concurrency note). Owner identity = THIS process's active session id —
  // startWebUI is its own process, never a copied CLI-leader closure.
  const wrongTraceHooks = createWrongTraceHookPair(() => context.session.id, {
    baseDir: () => context.cwd,
    emit: (event) => {
      events.emit('wrongtrace.gate.decision', event);
      // Shared counters contract (see adapter gate-counters.ts): this
      // process's tally is persisted per gate decision — the standalone
      // server has no single session-end hook, and last writer wins
      // against the CLI's session-end persist. `wstack proxy-status`
      // reads whatever the latest writer left.
      recordGateDecision(event);
      void persistWrongTraceGateCounters(projectRoot, snapshotGateDecisions());
    },
  });
  wrongTraceHookRegistry.registerInProcess(
    'PreToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    wrongTraceHooks.preToolUse,
    'wrongtrace-gate',
  );
  wrongTraceHookRegistry.registerInProcess(
    'PostToolUse',
    'edit|write|replace|patch|codebase-ast-replace',
    wrongTraceHooks.postToolUse,
    'wrongtrace-gate',
    // Also on a denied / rejected / failed call: release the lock PreToolUse took.
    { runWhenToolSkipped: true },
  );
  const wrongTraceHookRunner = new HookRunner({
    registry: wrongTraceHookRegistry,
    sessionId: () => context.session.id,
    // Coordination, not enforcement: these hooks are fail-open by
    // construction and must run regardless of shell-hook gating.
    allowNonPolicy: true,
  });
  const toolExecutor = new ToolExecutor(toolRegistry, {
    permissionPolicy,
    secretScrubber,
    renderer,
    events,
    confirmAwaiter: undefined,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    perIterationOutputCapBytes:
      config.tools?.perIterationOutputCapBytes ?? DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    tracer: input.tracer,
    hookRunner: wrongTraceHookRunner,
    // Off unless the operator opts in. The WebUI drives the same agent as the
    // CLI, so it must resolve this identically — a surface-dependent gate
    // would mean the same repo governs under `wstack` and not in the browser.
    // See packages/cli/src/wiring/pipeline.ts.
    requireKanbanGovernance:
      config.tools?.kanbanGovernance ?? DEFAULT_TOOLS_CONFIG.kanbanGovernance,
  });
  input.installToolBoundary?.(pipelines);

  // Mailbox bridge discovery — fire-and-forget. Best-effort: a failed
  // discovery never blocks the WebUI from starting.
  const webuiLogger = container.resolve(TOKENS.Logger);
  void discoverMailboxBridgeForWebui({
    projectRoot,
    config,
    logger: webuiLogger,
    ctx: context,
  }).catch((err: unknown) => {
    webuiLogger.warn('mailbox bridge discovery threw on webui boot', {
      err: errMessage(err),
    });
  });

  const agent = new Agent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    refreshSystemPrompt: true,
    context,
    maxIterations: config.tools?.maxIterations ?? DEFAULT_TOOLS_CONFIG.maxIterations,
    iterationTimeoutMs: config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
    executionStrategy:
      config.tools?.defaultExecutionStrategy ?? DEFAULT_TOOLS_CONFIG.defaultExecutionStrategy,
    perIterationOutputCapBytes:
      config.tools?.perIterationOutputCapBytes ?? DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
    loopDetection: config.tools?.loopDetection ?? DEFAULT_TOOLS_CONFIG.loopDetection,
    confirmAwaiter: undefined,
    toolExecutor,
    tracer: input.tracer,
  });
  // Design Studio — hold a turn whose UI changes were not inspected rendered.
  installDesignTurnGate({
    pipelines,
    extensions: agent.extensions,
    hasTool: (name) => agent.tools.get(name) !== undefined,
  });
  // Model fallback (CLI parity: provider-runtime-setup.ts). The template agent
  // gets its own instance; every per-tab agent gets one in
  // createSessionAgentManager.
  const getLiveConfig = () => input.getConfig?.() ?? input.config;
  installConversationFallback(agent, {
    getConfig: getLiveConfig,
    providerRegistry,
    modelsRegistry,
    container,
    events,
    logger,
    // The leader's context is the one this process-wide updater serves (the desktop runs one
    // conversation per engine): a hop re-resolves its context window and compaction ceiling.
    onModelSwitch: (providerId) => updateAutoCompactionMaxContext(agent.ctx.provider, providerId),
  });
  if (config.features.memory && config.features.memoryConsolidation !== false) {
    const consSage = getSageService(memoryStore) as ConsolidatorSage | undefined;
    agent.extensions.register(
      new SessionMemoryConsolidator({
        memoryStore,
        ...(consSage ? { Sage: consSage } : {}),
      }),
    );
  }
  // SAGE background passes (daily consolidation, triage) on the
  // `memory-curator` route, through the agent's provider chain (CLI parity:
  // cli-main-boot.ts). Providers are built with the Brain's saved-config rule.
  const fallbackProfileManager = container.safeResolve(TOKENS.FallbackProfileManager);
  if (fallbackProfileManager) {
    memoryCuratorLlm = createMemoryCuratorLlmCall({
      buildProvider: (providerId) => buildSavedProvider(providerRegistry, input.config, providerId),
      getConfig: () => input.config,
      fallbackProfileManager,
      statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker),
      wrapProviderCall: (request, inner) =>
        agent.extensions.wrapProviderRunner(
          (_ctx: typeof agent.ctx, wrapped: typeof request) => inner(wrapped),
          { exclude: ['fallback-model'] },
        )(agent.ctx, request),
    });
  }
  console.log('[WebUI] Agent initialized');

  const brainServices = createBackendBrain({
    config,
    getHostConfig: () => input.config,
    context,
    provider,
    providerRegistry,
    events,
    container,
    logger,
    wpaths,
    persistBrainConfig: input.persistBrainConfig,
  });
  const { brain, brainSettings, brainRuntime, brainLog, brainMonitor } = brainServices;

  // Per-feature WebSocket handlers.
  const subagentFactory = makeLightSubagentFactory({
    container,
    providerRegistry,
    toolRegistry,
    session: input.sessionGetter(),
    projectRoot,
    statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker),
    hookRunner: wrongTraceHookRunner,
    ...(input.installToolBoundary ? { installToolBoundary: input.installToolBoundary } : {}),
  });
  // Goal and SDD runs mirror into project boards, so a run can be followed and steered from Kanban.
  const broadcastToClients = input.broadcastToClients;
  const kanbanRunMirror =
    projectRoot && broadcastToClients
      ? createKanbanRunMirror({
          projectRoot,
          events,
          broadcast: broadcastToClients,
          log: (message) => logger.debug(`[KanbanRunMirror] ${message}`),
        })
      : null;
  const goalHandler = new GoalWebSocketHandler(
    agent,
    context,
    logger,
    wpaths.projectAutophase,
    events,
    projectRoot,
    kanbanRunMirror ? (graphId, state) => kanbanRunMirror.onGoalState(graphId, state) : undefined,
    subagentFactory,
  );
  const specsHandler = new SpecsWebSocketHandler(wpaths.projectSpecs, wpaths.projectTaskGraphs);
  const sddBoardHandler = new SddBoardWebSocketHandler(
    wpaths.projectSddBoards,
    undefined,
    {
      projectRoot,
      paths: {
        projectSpecs: wpaths.projectSpecs,
        projectTaskGraphs: wpaths.projectTaskGraphs,
        projectSddSession: wpaths.projectSddSession,
        projectSddBoards: wpaths.projectSddBoards,
      },
    },
    { trustBoundary: input.trustBoundary, logger },
  );
  const sddWizardHandler = new SddWizardWebSocketHandler(
    buildSddWizardDeps({
      agent,
      events,
      projectRoot,
      brain,
      // Shared factory, fresh Agent/Context per task. Goal and SDD workers use
      // the same provider health, hook, and tool-boundary policy.
      subagentFactory,
      paths: {
        projectSpecs: wpaths.projectSpecs,
        projectTaskGraphs: wpaths.projectTaskGraphs,
        projectSddBoards: wpaths.projectSddBoards,
        projectDir: wpaths.projectDir,
        projectSddSession: wpaths.projectSddSession,
      },
    }),
  );
  const worktreeHandler = new WorktreeWebSocketHandler(events, logger, {
    projectRoot,
    boardsDir: wpaths.projectSddBoards,
  });
  const terminalHandler = new TerminalWebSocketHandler(
    () => workingDir,
    logger,
    undefined,
    undefined,
    input.trustBoundary,
  );
  const collabHandler = new CollaborationWebSocketHandler(
    events,
    logger,
    input.sessionReader,
    input.annotationsStore,
    collabBus,
    {
      getActiveSessionId: () => context.session.id,
      scrubPayload: (value) => secretScrubber.scrubObject(value),
    },
  );
  let realtimeHandlersDisposed = false;
  const disposeRealtimeHandlers = () => {
    if (realtimeHandlersDisposed) return;
    realtimeHandlersDisposed = true;
    brainServices.dispose();
    goalHandler.dispose();
    kanbanRunMirror?.dispose();
    sddBoardHandler.dispose();
    sddWizardHandler.dispose();
    specsHandler.dispose();
    worktreeHandler.dispose();
    terminalHandler.dispose();
    collabHandler.dispose();
  };

  const MAX_CONCURRENT_SESSION_AGENTS = 4;
  /**
   * One Agent per open tab.
   *
   * The shared registry owns the bookkeeping (cap, eviction order, the
   * placeholder-writer question); only the CONSTRUCTION is local, because a
   * standalone session agent inherits this host's tool/iteration config rather
   * than cloning a template agent's.
   */
  const { sessionAgents } = createSessionAgentManager({
    agent,
    MAX_CONCURRENT_SESSION_AGENTS,
    input,
    projectRoot,
    workingDir,
    context,
    modelsRegistry,
    container,
    toolRegistry,
    providerRegistry,
    events,
    pipelines,
    config,
    getConfig: input.getConfig,
    toolExecutor,
    logger,
  });
  const getAgentForSession = (sessionId?: string): Agent => sessionAgents.get(sessionId);

  return {
    collabBus,
    compactor,
    autoCompactor,
    toolExecutor,
    agent,
    getAgent: getAgentForSession,
    // Read-only lookups go through `peek`: `get` CREATES, so asking a question
    // about a stale session id used to materialise an agent for it and could
    // evict a live tab's.
    peekAgent: (sessionId?: string) => sessionAgents.peek(sessionId),
    // Conversations holding a live agent. A setting that belongs to the whole
    // project has to reach every one of them, not just the leader.
    sessionAgentIds: () => sessionAgents.ids(),
    isSessionLive: (sessionId: string) => sessionAgents.isLive(sessionId),
    // Journal durability for the tabs that are NOT the leader's — the host's
    // own teardown and salvage hook only know the leader's writer.
    flushSessionJournalsSync: () => sessionAgents.flushAllSync(),
    closeSessionJournals: () => sessionAgents.closeAll(),
    permissionPolicy,
    pipelines,
    brain,
    brainSettings,
    brainRuntime,
    brainLog,
    brainMonitor,
    // Getter: ledger toggles swap the instance, shutdown must stop the LIVE one.
    get brainLedger() {
      return brainServices.brainLedger;
    },
    codebaseIndexing,
    subagentFactory,
    goalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    collabHandler,
    disposeRealtimeHandlers,
    runSageSessionHygiene,
    updateAutoCompactionMaxContext,
  };
}
