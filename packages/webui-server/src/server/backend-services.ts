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
import { join } from 'node:path';
import { type AgentPipelines, Context } from '@wrongstack/core/agent';
import type { CollaborationBus, ObservableBrainArbiter } from '@wrongstack/core/coordination';
import type {
  AutoCompactionMiddleware,
  BrainAutoRisk,
  BrainRuntime,
} from '@wrongstack/core/execution';
import type { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import {
  CONTEXT_MANAGER_TOOL_NAME,
  createContextManagerTool,
} from '@wrongstack/core/infrastructure';
import type { Container, EventBus } from '@wrongstack/core/kernel';
import type { DefaultModeStore } from '@wrongstack/core/models';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { SkillInstaller } from '@wrongstack/core/skills';
import type { ConsolidatorSage, SessionReader } from '@wrongstack/core/storage';
import type {
  Compactor,
  Logger,
  MemoryPort,
  ModelsRegistry,
  PermissionPolicy,
  Provider,
  SessionStore,
  SkillLoader,
} from '@wrongstack/core/types';

/** Session shape returned by `SessionStore.create()`. */
type Session = Awaited<ReturnType<SessionStore['create']>>;

import { Agent } from '@wrongstack/core/agent';
import {
  BrainDecisionLedger,
  BrainMonitor,
  CollaborationBus as CollaborationBusCtor,
  collabInjectMiddleware,
  collabPauseMiddleware,
  EscalationRoutingBrainArbiter,
  getSharedProjectMailbox,
  mailboxSessionTag,
  ObservableBrainArbiter as ObservableBrainArbiterCtor,
} from '@wrongstack/core/coordination';
import { installDesignStudioMiddleware } from '@wrongstack/core/design';
import {
  AutoCompactionMiddleware as AutoCompactionMiddlewareCtor,
  createBrainRuntime,
  createStrategyCompactor,
  resolveBrainConfigDefaults,
  ToolExecutor,
} from '@wrongstack/core/execution';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import { TOKENS } from '@wrongstack/core/kernel';
import { type AnnotationsStore, SessionMemoryConsolidator } from '@wrongstack/core/storage';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  type Config,
  DEFAULT_TOOLS_CONFIG,
  type ProviderConfig,
  resolveContextWindowPolicy,
} from '@wrongstack/core/types';
import {
  estimateRequestTokensCalibrated,
  toErrorMessage,
  type WstackPaths,
} from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import { makeLightSubagentFactory } from '@wrongstack/runtime';
import { getSageService, setupSage } from '@wrongstack/sage';
import { installVibeProtocol } from '@wrongstack/sdd';
import {
  createWrongTraceHookPair,
  persistWrongTraceGateCounters,
  recordGateDecision,
  snapshotGateDecisions,
} from '@wrongstack/wrongtrace';
import { setupWebUICodebaseIndexing } from './codebase-indexing.js';
import { CollaborationWebSocketHandler } from './collaboration-ws-handler.js';
import { discoverMailboxBridgeForWebui } from './discover-mailbox-bridge.js';
import { GoalWebSocketHandler } from './goal-ws-handler.js';
import { resolveProviderModelMetadata } from './model-catalog.js';
import { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import { buildSddWizardDeps } from './sdd-wizard-wiring.js';
import { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { createSessionAgentRegistry, createSessionTokenCounter } from './session-agent-registry.js';
import { SpecsWebSocketHandler } from './specs-ws-handler.js';
import { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import { WorktreeWebSocketHandler } from './worktree-ws-handler.js';

interface AgentServicesInput {
  trustBoundary: TrustBoundary;
  config: Config;
  wpaths: WstackPaths;
  logger: Logger;
  projectRoot: string;
  workingDir: string;
  /** Pre-context services (built in startWebUI with opts.services injection). */
  context: Context;
  provider: Provider;
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  modelsRegistry: ModelsRegistry;
  events: EventBus;
  mcpRegistry: MCPRegistry;
  memoryStore: MemoryPort;
  modeStore: DefaultModeStore;
  customModeStore: import('./custom-context-modes.js').CustomModeStore;
  skillLoader: SkillLoader | undefined;
  skillInstaller: SkillInstaller | undefined;
  tokenCounter: DefaultTokenCounter;
  pipelines: AgentPipelines;
  /** Trusted host-only hook shared by the leader and light-subagent pipelines. */
  installToolBoundary?: ((pipelines: AgentPipelines) => void) | undefined;
  /** Mutable capabilities ref — the factory populates `.current`. */
  modelCapabilitiesRef: { current: unknown };
  /** Returns the LIVE session (swapped on /new + resume) — read at send time. */
  sessionGetter: () => Session;
  /** Read-only session reader (collab replay-on-join). */
  sessionReader: SessionReader;
  /**
   * True while `sessionId` has an in-flight run. Consulted before evicting a
   * session agent: the registry is capped at the tab limit, so without this a
   * fifth lookup would drop a tab that is mid-turn and strand its transcript.
   */
  isRunActive?: ((sessionId: string) => boolean) | undefined;
  /**
   * Is any connected surface still showing `sessionId`?
   *
   * Also consulted before eviction, and it decides WHICH agent goes. Insertion
   * order alone picks the oldest, which is routinely a tab the user still has
   * open, while the agent of a tab they closed minutes ago survives because it
   * was created later.
   */
  isDisplayed?: ((sessionId: string) => boolean) | undefined;
  /** Annotations store (collab notes). */
  annotationsStore: AnnotationsStore;
  /**
   * Persist the canonical `config.brain` to the GLOBAL config (serialized
   * behind startWebUI's config write lock). Absent = Brain edits are
   * live-only.
   */
  persistBrainConfig?:
    | ((config: import('@wrongstack/core/types').BrainConfig) => Promise<void>)
    | undefined;
}

interface AgentServices {
  collabBus: CollaborationBus;
  compactor: Compactor;
  autoCompactor: AutoCompactionMiddleware | undefined;
  toolExecutor: ToolExecutor;
  agent: Agent;
  getAgent?: (sessionId?: string) => Agent;
  /**
   * The Agent for a session WITHOUT creating one. Read-only callers (status
   * logging, introspection, "can this host serve that id") must use this:
   * `getAgent` creates, so asking about a stale id materialised an agent and
   * could evict a live tab's.
   */
  peekAgent?: (sessionId?: string) => Agent | undefined;
  /** Conversations holding a live agent — see `WebuiDeps.sessionAgentIds`. */
  sessionAgentIds?: () => string[];
  /** Does this host already hold an open journal writer for that session? */
  isSessionLive?: (sessionId: string) => boolean;
  /** Drain every open tab's journal synchronously — fatal-exit salvage. */
  flushSessionJournalsSync?: () => void;
  /** End + close the journals of every tab that is not the leader's. */
  closeSessionJournals?: () => Promise<void>;
  permissionPolicy: PermissionPolicy;
  pipelines: AgentPipelines;
  brain: ObservableBrainArbiter;
  brainSettings: { maxAutoRisk: BrainAutoRisk };
  /** Live-editable Brain config owner (brain.config.get/set routes). */
  brainRuntime: BrainRuntime;
  brainLog: Array<{
    at: number;
    kind: string;
    question: string;
    outcome: string;
    sessionId?: string | undefined;
  }>;
  brainMonitor: BrainMonitor;
  /** LIVE persistent decision ledger (undefined when disabled). Read via the
   *  services object at shutdown — ledger toggles swap the instance. */
  brainLedger: BrainDecisionLedger | undefined;
  codebaseIndexing: { onFileWritten(filePath: string): void; dispose(): void };
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  collabHandler: CollaborationWebSocketHandler;
  /** Release event subscriptions, timers, subprocesses and socket references
   * owned by the per-feature handlers. Idempotent handler disposers make this
   * safe during both signal shutdown and programmatic server restarts. */
  disposeRealtimeHandlers(): void;
  /**
   * Shared SAGE teardown: flush counters + throttled session-end hygiene
   * (full config surface). Same contract as CLI `setupSage` teardown.
   */
  runSageSessionHygiene(): Promise<void>;
  /** Refresh auto-compaction denominator on model switch. */
  updateAutoCompactionMaxContext: (
    newProvider: Provider,
    providerId?: string,
    providerCfg?: ProviderConfig | undefined,
  ) => Promise<void>;
}

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
  const runSageSessionHygiene = setupSage({
    config,
    pipelines,
    memoryStore,
    logger,
    events,
    getSessionId: () => input.sessionGetter().id,
    projectRoot,
  });
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
  });

  // `context_manager` — registered HERE, not in `registerCanonicalHostTools`.
  //
  // The CLI passes `contextTool` into that canonical call because it builds its
  // compactor first. This server can't: `createPreContextServices` builds the
  // tool registry (start-webui.ts) long before `createAgentServices` builds the
  // compactor above, so the canonical call runs with no compactor to hand it.
  // The result was a surface gap — the model could self-manage its context
  // under `wstack` but not in the desktop app or the standalone server, both of
  // which boot through this path.
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
    effectiveMaxContext = m?.capabilities?.maxContext ?? 0;
  } catch {
    // best-effort: fall through to the configured value / provider capability
  }
  if (!effectiveMaxContext) effectiveMaxContext = config.context?.effectiveMaxContext ?? 0;
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
  const updateAutoCompactionMaxContext = async (
    newProvider: Provider,
    providerId = newProvider.id,
    providerCfg?: ProviderConfig | undefined,
  ): Promise<void> => {
    await modelsRegistry.refresh().catch((err) => {
      logger.warn(
        `models.dev refresh failed for ${providerId}/${context.model}: ${toErrorMessage(err)}; using cached catalog`,
      );
    });
    const currentConfig = input.config;
    let newMaxContext =
      currentConfig.context?.effectiveMaxContext ?? newProvider.capabilities.maxContext;
    try {
      const m = await resolveProviderModelMetadata(
        modelsRegistry,
        providerId,
        context.model,
        providerCfg ?? currentConfig.providers?.[providerId],
      );
      newMaxContext = m?.capabilities?.maxContext ?? newMaxContext;
    } catch {
      // best-effort: use provider capability
    }
    newProvider.capabilities.maxContext = newMaxContext;
    modelCapabilitiesRef.current =
      newMaxContext > 0
        ? {
            maxContextTokens: newMaxContext,
            supportsTools: !!newProvider.capabilities.tools,
            supportsVision: !!newProvider.capabilities.vision,
            supportsReasoning: !!newProvider.capabilities.reasoning,
          }
        : undefined;
    if (newMaxContext > 0) {
      context.meta['effectiveMaxContext'] = newMaxContext;
      autoCompactor?.setMaxContext(newMaxContext);
      autoCompactor?.setEnabled(config.context?.autoCompact !== false);
      // Window changed (model switch): re-resolve the default policy so it
      // stays scaled to the window (≥1M defaults to Deep, smaller back to
      // Balanced). A policy the user pinned for this session is left alone.
      if (context.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] !== true) {
        const policy = resolveContextWindowPolicy(
          currentConfig.context ?? {},
          undefined,
          newMaxContext,
        );
        context.meta['contextWindowMode'] = policy.id;
        context.meta['contextWindowPolicy'] = policy;
      }
    } else {
      delete context.meta['effectiveMaxContext'];
      autoCompactor?.setEnabled(false);
    }
    events.emit('ctx.max_context', {
      sessionId: context.session.id,
      providerId: newProvider.id,
      modelId: context.model,
      maxContext: newMaxContext,
    });
  };

  // Agent
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
    tracer: undefined,
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
      err: err instanceof Error ? err.message : String(err),
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
  console.log('[WebUI] Agent initialized');

  // ── Brain — policy → LLM/council → terminal-policy decision layer ──────
  // The standalone WebUI has no blocking human prompt surface, so the
  // escalation tier always resolves through the terminal policy (safe
  // default or deny) — the Brain never returns a dangling `ask_human`.
  // The whole `config.brain` surface is owned by a BrainRuntime: the
  // brain.config.set route live-rebuilds the tiers AND persists globally
  // (config.brain is on the in-project deny list).
  // Product defaults (minimum-human): pool seeded from fallbackModels,
  // adaptive risk ceiling. Explicit config.brain fields always win.
  const brainCfg = resolveBrainConfigDefaults(config.brain, {
    fallbackModels: config.fallbackModels,
  });
  const brainLedgerPath = join(wpaths.projectDir, 'brain-ledger.jsonl');
  let brainLedgerEnabled = brainCfg.ledger?.enabled !== false;
  let brainLedger: BrainDecisionLedger | undefined;
  const startBrainLedger = (): void => {
    if (brainLedger) return;
    brainLedger = new BrainDecisionLedger({ events, filePath: brainLedgerPath });
    void brainLedger.start();
  };
  if (brainLedgerEnabled) startBrainLedger();
  // Declared before the runtime so `onApplied` can re-tune it; assigned below,
  // once the Brain chain it consults exists.
  let brainMonitor: BrainMonitor | undefined;
  const brainRuntime = createBrainRuntime({
    initialConfig: brainCfg,
    defaultProviderId: config.provider,
    sessionProvider: () => provider,
    sessionModel: () => context.model,
    resolveProvider: (providerId) => {
      const savedCfg: Partial<import('@wrongstack/core/types').ProviderConfig> =
        config.providers?.[providerId] ?? {};
      return providerRegistry.create({
        ...savedCfg,
        apiKey: savedCfg.apiKey ?? config.apiKey,
        baseUrl: savedCfg.baseUrl ?? config.baseUrl,
        type: providerId,
      } as never);
    },
    ledger: {
      getPath: () => (brainLedgerEnabled ? brainLedgerPath : undefined),
      isEnabled: () => brainLedgerEnabled,
      setEnabled: (on) => {
        brainLedgerEnabled = on;
        if (on) {
          startBrainLedger();
        } else {
          void brainLedger?.stop();
          brainLedger = undefined;
        }
      },
      failureStreakFor: (request) => brainLedger?.failureStreakFor(request) ?? 0,
      getDecisionDigest: (request) => brainLedger?.digestFor(request),
    },
    persist: input.persistBrainConfig,
    // Keep the monitor's thresholds live, same as the CLI host. `reconfigure`
    // no-ops when the monitor block is unchanged, so unrelated Brain edits
    // (risk, pool, council) do not reset its in-flight failure streaks.
    onApplied: (snapshot) => {
      brainMonitor?.reconfigure(snapshot.monitor);
    },
  });
  // Back-compat facade for the risk-only route: assignment routes through
  // runtime.apply(), which live-applies AND persists.
  const brainSettings: { maxAutoRisk: BrainAutoRisk } = {
    get maxAutoRisk() {
      return brainRuntime.getMaxAutoRisk();
    },
    set maxAutoRisk(level: BrainAutoRisk) {
      void brainRuntime.apply({ maxAutoRisk: level }).persisted;
    },
  };
  const brain = new ObservableBrainArbiterCtor(
    new EscalationRoutingBrainArbiter(brainRuntime.arbiter, undefined, () => 'headless'),
    events,
  );
  container.bind(TOKENS.BrainArbiter, () => brain);

  // Decision log for the /brain command — last 20 decisions, newest last.
  // `sessionId` is carried so a tab can be shown ITS decisions: the Brain is
  // project-wide, but a decision is always about one session's tool call, and
  // an unlabelled mixture of four tabs' decisions answers nobody's question.
  const brainLog: Array<{
    at: number;
    kind: string;
    question: string;
    outcome: string;
    sessionId?: string | undefined;
  }> = [];
  const pushBrainLog = (entry: (typeof brainLog)[number]) => {
    brainLog.push(entry);
    if (brainLog.length > 20) brainLog.shift();
  };
  const brainLogOffs = [
    events.on('brain.decision_answered', (e) =>
      pushBrainLog({
        at: e.at,
        sessionId: e.sessionId,
        kind: 'answered',
        question: e.request.question,
        outcome: e.decision.type === 'answer' ? (e.decision.optionId ?? e.decision.text) : '',
      }),
    ),
    events.on('brain.decision_ask_human', (e) =>
      pushBrainLog({
        at: e.at,
        sessionId: e.sessionId,
        kind: 'ask_human',
        question: e.request.question,
        outcome: 'needs human judgement',
      }),
    ),
    events.on('brain.decision_denied', (e) =>
      pushBrainLog({
        at: e.at,
        sessionId: e.sessionId,
        kind: 'denied',
        question: e.request.question,
        outcome: e.decision.type === 'deny' ? e.decision.reason : '',
      }),
    ),
  ];

  // Self-activation: watch for tool-failure streaks / error storms. `session`
  // is read at send time via the getter the caller passes, so the steer
  // always targets the LIVE session's leader identity.
  const brainMailbox = getSharedProjectMailbox(wpaths.projectDir, events);
  brainMonitor = new BrainMonitor({
    events,
    brain,
    // The full `config.brain.monitor` surface, matching the CLI host. Boot used
    // to skip enabled/policy/signals/errorStormWindowMs/stallCheckIntervalMs/
    // fileEditTools, so those settings were inert here — and now that
    // `reconfigure()` applies the whole block, an unrelated Brain edit would
    // have been the first thing to honour them.
    enabled: brainCfg.monitor?.enabled,
    policy: brainCfg.monitor?.policy,
    signals: brainCfg.monitor?.signals,
    toolFailureStreak: brainCfg.monitor?.toolFailureStreak,
    errorStormCount: brainCfg.monitor?.errorStormCount,
    errorStormWindowMs: brainCfg.monitor?.errorStormWindowMs,
    stallMs: brainCfg.monitor?.stallMs,
    stallCheckIntervalMs: brainCfg.monitor?.stallCheckIntervalMs,
    fileChurnThreshold: brainCfg.monitor?.fileChurnThreshold,
    fileChurnWindowMs: brainCfg.monitor?.fileChurnWindowMs,
    fileEditTools: brainCfg.monitor?.fileEditTools,
    cooldownMs: brainCfg.monitor?.cooldownMs,
    // Watch the session that is actually in front. Pinning this to the ROOT
    // context meant the monitor kept watching whichever session the host
    // booted on, while `intervene` steered the live one — with several
    // sessions under one host those are different tabs.
    sessionId: () => input.sessionGetter().id,
    intervene: async ({ subject, body, sessionId }) => {
      // Steer the session whose distress triggered this, not "the current
      // one": by the time an LLM-backed engagement resolves, the user may
      // have switched tabs.
      const tag = mailboxSessionTag(sessionId || input.sessionGetter().id);
      await brainMailbox.send({
        from: `brain@${tag}`,
        to: `leader@${tag}`,
        type: 'steer',
        subject,
        body,
        priority: 'high',
      });
    },
  });
  brainMonitor.start();
  console.log('[WebUI] Brain initialized (tiered policy → LLM, monitor active)');

  // Per-feature WebSocket handlers.
  const goalHandler = new GoalWebSocketHandler(
    agent,
    context,
    logger,
    wpaths.projectAutophase,
    events,
    projectRoot,
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
      subagentFactory: makeLightSubagentFactory({
        container,
        providerRegistry,
        toolRegistry,
        session: input.sessionGetter(),
        projectRoot,
        // Thread the container-provided ProviderModelStatusTracker so a 429
        // from this subagent's first call transitions the (provider, model)
        // pair to `state: 'blocked'` instead of silently no-op'ing. The
        // runtime container binds a default `ProviderModelStatusTracker`
        // (see packages/runtime/src/container.ts); without this dep, the
        // subagent's fallback extension's tracker hooks are undefined and
        // round-robin keeps reassigning the doomed model. Mirrors the CLI
        // factory wiring at host-subagent-factory.ts:337.
        statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker),
        // WrongTrace lock gate for SDD-wizard workers: the standalone server
        // already built a dedicated WrongTrace-only HookRunner for its own
        // executor above; handing the same runner to the runtime factory
        // makes every worker edit honor peer locks with one process-wide
        // owner identity (context.session.id).
        hookRunner: wrongTraceHookRunner,
        ...(input.installToolBoundary ? { installToolBoundary: input.installToolBoundary } : {}),
      }),
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
    },
  );
  let realtimeHandlersDisposed = false;
  const disposeRealtimeHandlers = () => {
    if (realtimeHandlersDisposed) return;
    realtimeHandlersDisposed = true;
    for (const off of brainLogOffs) off();
    goalHandler.dispose();
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
  const sessionAgents = createSessionAgentRegistry({
    template: agent,
    maxAgents: MAX_CONCURRENT_SESSION_AGENTS,
    ...(input.isRunActive ? { isRunActive: input.isRunActive } : {}),
    ...(input.isDisplayed ? { isDisplayed: input.isDisplayed } : {}),
    createAgent: (sessionId) => {
      const sessionCtx = new Context({
        projectRoot,
        cwd: workingDir,
        model: context.model,
        provider: context.provider,
        // A placeholder writer: the real one is installed by the session
        // transition (`session.new` / `session.resume`) that owns this id.
        session: { id: sessionId, traceId: context.traceId } as Session,
        traceId: context.traceId,
        systemPrompt: context.systemPrompt,
        agentId: 'leader',
        agentName: 'Leader Agent',
        allowOutsideProjectRoot: context.allowOutsideProjectRoot,
        signal: context.signal,
        // The session's own counter (see createSessionTokenCounter): reads are
        // this tab's, writes still reach the process-wide one.
        tokenCounter: createSessionTokenCounter({
          root: input.tokenCounter,
          sessionId,
          registry: modelsRegistry,
          providerId: () => context.provider?.id,
        }),
      });
      Object.assign(sessionCtx.meta, context.meta);
      return new Agent({
        container,
        tools: toolRegistry,
        providers: providerRegistry,
        events,
        pipelines,
        refreshSystemPrompt: true,
        context: sessionCtx,
        maxIterations: config.tools?.maxIterations ?? DEFAULT_TOOLS_CONFIG.maxIterations,
        iterationTimeoutMs:
          config.tools?.iterationTimeoutMs ?? DEFAULT_TOOLS_CONFIG.iterationTimeoutMs,
        executionStrategy:
          config.tools?.defaultExecutionStrategy ?? DEFAULT_TOOLS_CONFIG.defaultExecutionStrategy,
        perIterationOutputCapBytes:
          config.tools?.perIterationOutputCapBytes ??
          DEFAULT_TOOLS_CONFIG.perIterationOutputCapBytes,
        loopDetection: config.tools?.loopDetection ?? DEFAULT_TOOLS_CONFIG.loopDetection,
        confirmAwaiter: undefined,
        toolExecutor,
      });
    },
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
      return brainLedger;
    },
    codebaseIndexing,
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
