import { join } from 'node:path';
import { TOKENS } from '@wrongstack/contracts/kernel';
import {
  type Config,
  normalizeTokenSavingTier,
  type Provider,
  type SecretVault,
  type SessionWriter,
  type Tracer,
} from '@wrongstack/contracts/types';
import {
  BrainDecisionLedger,
  BrainDecisionQueue,
  type BrainEscalationMode,
  BrainMonitor,
  BrainTraceRecorder,
  createDelegateTool,
  createSystemOneTierSuggester,
  DelegationTracker,
  EscalationRoutingBrainArbiter,
  ObservableBrainArbiter,
  renderLeaderModelMenu,
  terminalPolicyDecision,
} from '@wrongstack/core/coordination';
import {
  type BrainAutoRisk,
  type BrainRuntime,
  createBrainRuntime,
  resolveBrainConfigDefaults,
} from '@wrongstack/core/execution';
import type { ToolRegistry } from '@wrongstack/core/registry';
import {
  createMcpControlTool,
  createMcpUseTool,
  createSessionRenameTool,
  SESSION_RENAME_TOOL_NAME,
} from '@wrongstack/tools/management';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';
import { subscribeBrainDecisionLog } from '../boot/brain-decision-log.js';
import { installedBridgeAgents } from '../fleet/acp-wrongstack-bridge.js';
import { createSubagentWrongTraceHookRunner } from '../fleet/subagent-hook-runner.js';
import { wrongForgeDelegateEntry } from '../fleet/wrongforge-runner.js';
import { MultiAgentHost } from '../multi-agent.js';
import { activeProfileConfigPath } from '../profile-config-path.js';
import { persistConfigSetting } from '../settings-menu.js';
import { buildProviderForId } from './provider-runtime.js';
import { recordGateDecision } from './wrongtrace-gate-counters.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: large dep bag
type AnyObj = any;

/**
 * Live-mutable Brain settings shared with `/brain` (risk + mode subcommands)
 * and the TUI Brain panel. `describe` fields are static wiring facts surfaced
 * in `/brain status`.
 */
export interface BrainRuntimeSettings {
  maxAutoRisk: BrainAutoRisk;
  /** 'headless' = never block on a human; terminal policy resolves escalations. */
  mode: BrainEscalationMode;
  /** Human-readable pool labels (e.g. "anthropic/claude-haiku"), empty = session model. */
  readonly poolLabels: string[];
  /** Human-readable council seat labels, empty = council disabled. */
  readonly councilLabels: string[];
  /** Absolute path of the persistent decision ledger (undefined = disabled). */
  readonly ledgerPath?: string | undefined;
}

interface BrainOrchestrationDeps {
  /** OTLP tracer; subagent runs nest under the leader turn that spawned them. */
  tracer?: Tracer | undefined;
  events: AnyObj;
  config: Config;
  /** Secret vault for the global-config persist path of Brain settings. */
  vault: SecretVault;
  container: AnyObj;
  provider: Provider;
  session: SessionWriter;
  context: AnyObj;
  toolRegistry: ToolRegistry;
  providerRegistry: AnyObj;
  configStore: AnyObj;
  modelsRegistry: AnyObj;
  promptBuilder: AnyObj;
  tokenCounter: AnyObj;
  skillLoader: import('@wrongstack/contracts/types').SkillLoader | undefined;
  projectRoot: string;
  cwd: string;
  wpaths: AnyObj;
  teardownHandlers: (() => void)[];
  mailboxSessionTag: (id: string) => string;
  brainMailbox: AnyObj;
  agentMonitor: AnyObj;
  // (directorMode removed — Director Mode is permanently on)
  manifestPath: string | undefined;
  sharedScratchpadPath: string | undefined;
  subagentSessionsRoot: string | undefined;
  stateCheckpointPath: string | undefined;
  fleetRootForPromotion: string;
  maxConcurrent: number | undefined;
  maxSpawns?: number | undefined;
  maxConcurrentSource?: import('../fleet/budget-source.js').FleetBudgetSource | undefined;
  maxSpawnsSource?: import('../fleet/budget-source.js').FleetBudgetSource | undefined;
  effectiveMaxContextRef: { current: number };
  mcpRegistry: AnyObj;
  sessResult: AnyObj;
  /** Leader's active mode id — propagated to spawned subagents as memoryContext.mode. */
  modeId?: string | undefined;
  /** Shared provider/model status tracker for the Director. */
  statusTracker?: import('@wrongstack/core/coordination').ProviderModelStatusTracker | undefined;
  /** Trusted governance hook for in-process Fleet tool pipelines. */
  installToolBoundary?:
    | ((pipelines: import('@wrongstack/core/agent').AgentPipelines) => void)
    | undefined;
}

interface BrainOrchestrationResult {
  brain: ObservableBrainArbiter;
  brainLog: AnyObj[];
  /** Session-lifetime per-tier decision tally for `/brain stats`. */
  brainTierStats: () => import('@wrongstack/core/coordination').BrainTierStats;
  brainSettings: BrainRuntimeSettings;
  /** Live-editable Brain config owner (apply = live + persist-to-global). */
  brainRuntime: BrainRuntime;
  brainQueue: BrainDecisionQueue;
  multiAgentHost: MultiAgentHost;
  shadowController: AnyObj;
  shadowDefaults: { intervalMs?: number; provider?: string; model?: string };
}

/**
 * Wire the global Brain chain (policy → LLM → human), BrainMonitor,
 * shadow controller, MultiAgentHost (subagent orchestration), and
 * delegate/mcp_control/mcp_use tool registration.
 *
 * The HQ telemetry bridges (setupHqTelemetry) are called separately
 * between brain chain setup and brain monitor creation in cli-main.ts,
 * which is why this function has two logical halves stitched together.
 */
export function setupBrainAndOrchestration(deps: BrainOrchestrationDeps): BrainOrchestrationResult {
  const {
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
    skillLoader,
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
    installToolBoundary,
  } = deps;
  const profileConfigPath = activeProfileConfigPath(wpaths, config);

  // ── Global Brain chain — policy → LLM/council → escalation ─────────────
  // Escalation routing is config-driven: 'interactive' prompts the human,
  // 'headless' resolves through the terminal policy so the Brain NEVER
  // blocks on a person. Switch live with `/brain mode <m>`. The whole
  // `config.brain` surface (pool, council, timeouts, ledger) is owned by a
  // BrainRuntime: apply() rebuilds the inner tiers live AND persists to the
  // GLOBAL config (`brain` is on the in-project deny list).
  // Product defaults (minimum-human): headless mode, pool seeded from the
  // user's own fallbackModels (council auto-derives at ≥2), adaptive risk
  // ceiling. Resolved at boot — explicit config.brain fields always win.
  const brainCfg = resolveBrainConfigDefaults(config.brain, {
    fallbackModels: config.fallbackModels,
  });

  // Persistent decision ledger — records every decision + observed outcome
  // (budget extensions vs. later task results, steer re-triggers) and feeds
  // outcome stats of similar past decisions back into the LLM/council
  // prompts. Lives OUTSIDE the repo, per project, across sessions.
  // Start/stop is host-owned so the runtime can toggle it live.
  const ledgerPath = join(wpaths.projectDir, 'brain-ledger.jsonl');
  let ledgerEnabled = brainCfg?.ledger?.enabled !== false;
  let brainLedger: BrainDecisionLedger | undefined;
  const startLedger = (): void => {
    if (brainLedger) return;
    brainLedger = new BrainDecisionLedger({
      events,
      filePath: ledgerPath,
      maxMemoryEntries: brainCfg?.ledger?.maxMemoryEntries,
      interventionRetryWindowMs: brainCfg?.ledger?.interventionRetryWindowMs,
    });
    void brainLedger.start();
  };
  if (ledgerEnabled) startLedger();
  teardownHandlers.push(() => {
    void brainLedger?.stop();
  });

  // ── Replay trace ─────────────────────────────────────────────────────────
  // Per-decision record of HOW the ladder decided (tiers, every pool target
  // including failures, council votes, tokens). Opt-in: enabling it is what
  // permits production decision content on disk. Kept in its own file — the
  // ledger's bounded ring powers the learning loop and must not be diluted
  // by high-volume per-call rows.
  let brainTrace: BrainTraceRecorder | undefined;
  const applyTrace = (traceCfg: NonNullable<Config['brain']>['trace']): void => {
    if (traceCfg?.enabled !== true) {
      void brainTrace?.stop();
      brainTrace = undefined;
      return;
    }
    const settings = {
      filePath: traceCfg.path ?? join(wpaths.projectDir, 'brain-trace.jsonl'),
      content: traceCfg.content,
      maxOpenRecords: traceCfg.maxOpenRecords,
    };
    if (brainTrace) {
      brainTrace.reconfigure(settings);
      return;
    }
    brainTrace = new BrainTraceRecorder({
      events,
      filePath: traceCfg.path ?? join(wpaths.projectDir, 'brain-trace.jsonl'),
      content: traceCfg.content,
      maxOpenRecords: traceCfg.maxOpenRecords,
    });
    brainTrace.start();
  };
  applyTrace(brainCfg?.trace);
  teardownHandlers.push(() => {
    void brainTrace?.stop();
  });

  // Shared queue options object: BrainDecisionQueue keeps the REFERENCE, so
  // mutating timeoutMs in onApplied makes `/brain human-timeout` live. Do
  // not replace this with a defensive copy in the queue.
  const queueOpts = {
    timeoutMs: brainCfg?.humanTimeoutMs,
    userInputAwaiter: (...args: Parameters<NonNullable<typeof context.userInputAwaiter>>) =>
      context.userInputAwaiter?.(...args) ?? Promise.resolve(undefined),
    onTimeout: (request: Parameters<typeof terminalPolicyDecision>[0]) =>
      terminalPolicyDecision(request, brainRuntime.getSnapshot().terminalPolicy),
  };
  const brainQueue = new BrainDecisionQueue(events, queueOpts);

  // Declared before the runtime so `onApplied` can re-tune it; assigned below,
  // after the Brain chain it consults exists. A plain `const` further down
  // would leave the closure referencing a TDZ binding.
  let brainMonitor: BrainMonitor | undefined;

  const brainRuntime = createBrainRuntime({
    initialConfig: brainCfg,
    // The tiers emit brain.llm_call / brain.council_* onto this bus; the
    // recorder above is one subscriber, the settings surfaces are others.
    events,
    defaultProviderId: config.provider,
    sessionProvider: () => provider,
    sessionModel: () => config.model,
    resolveProvider: (providerId) => buildProviderForId({ config, providerRegistry }, providerId),
    // Read per decision: the live config, so a key added or a judgment
    // switched off mid-session takes effect on the next decision.
    getSystemOneJudge: () =>
      resolveTypeSafeJudge({
        config: (configStore.get?.() as Config | undefined) ?? config,
        feature: 'brain',
        logger: container.safeResolve(TOKENS.Logger),
      }),
    ledger: {
      getPath: () => (ledgerEnabled ? ledgerPath : undefined),
      isEnabled: () => ledgerEnabled,
      setEnabled: (on) => {
        ledgerEnabled = on;
        if (on) {
          startLedger();
        } else {
          void brainLedger?.stop();
          brainLedger = undefined;
        }
      },
      failureStreakFor: (request) => brainLedger?.failureStreakFor(request) ?? 0,
      getDecisionDigest: (request) => brainLedger?.digestFor(request),
    },
    // config.brain is denied in project scope, so persistence always targets
    // the active profile config.
    persist: (brainConfig) =>
      persistConfigSetting(
        {
          configStore,
          profileConfigPath,
          vault,
          forceGlobal: true,
        },
        (decrypted) => {
          decrypted['brain'] = brainConfig as never;
        },
      ),
    onApplied: (snapshot) => {
      queueOpts.timeoutMs = snapshot.humanTimeoutMs;
      // The monitor is constructed further down, so this fires against
      // whatever is bound by the time a setting actually changes. `reconfigure`
      // no-ops when the monitor block is unchanged, which matters because
      // onApplied runs for EVERY Brain setting — `/brain risk` must not reset
      // the monitor's in-flight failure streaks.
      brainMonitor?.reconfigure(snapshot.monitor);
      brainLedger?.reconfigure(snapshot.ledger);
      applyTrace(brainRuntime.getConfig().trace);
      brainLog.splice(0, Math.max(0, brainLog.length - snapshot.decisionLogMaxEntries));
    },
  });

  // Back-compat live settings facade: every existing mutation site
  // (`/brain risk|mode`, the TUI panel, the WebUI brain.risk handler)
  // assigns `brainSettings.maxAutoRisk/mode` — the accessors route those
  // through runtime.apply(), which live-applies AND persists.
  teardownHandlers.push(() => brainRuntime.dispose());
  const brainSettings: BrainRuntimeSettings = {
    get maxAutoRisk() {
      return brainRuntime.getMaxAutoRisk();
    },
    set maxAutoRisk(level: BrainAutoRisk) {
      void brainRuntime.apply({ maxAutoRisk: level }).persisted;
    },
    get mode() {
      return brainRuntime.getMode();
    },
    set mode(mode: BrainEscalationMode) {
      void brainRuntime.apply({ mode }).persisted;
    },
    get poolLabels() {
      return brainRuntime.getSnapshot().poolLabels;
    },
    get councilLabels() {
      return brainRuntime.getSnapshot().councilLabels;
    },
    get ledgerPath() {
      return brainRuntime.getSnapshot().ledger.path;
    },
  };

  const brain = new ObservableBrainArbiter(
    new EscalationRoutingBrainArbiter(
      brainRuntime.arbiter,
      brainQueue,
      () => brainRuntime.getMode(),
      () => brainRuntime.getSnapshot().terminalPolicy,
      events,
    ),
    events,
  );
  container.bind(TOKENS.BrainArbiter, () => brain);

  // Decision log for /brain status
  const {
    brainLog,
    getTierStats: brainTierStats,
    dispose: disposeBrainLog,
  } = subscribeBrainDecisionLog(events, () => brainRuntime.getSnapshot().decisionLogMaxEntries);
  teardownHandlers.push(disposeBrainLog);

  // NOTE: setupHqTelemetry() is called here in cli-main.ts between
  // brain chain and brain monitor. The function continues below.

  // ── Brain Monitor ────────────────────────────────────────────────────────
  brainMonitor = new BrainMonitor({
    events,
    brain,
    enabled: brainCfg?.monitor?.enabled,
    policy: brainCfg?.monitor?.policy,
    signals: brainCfg?.monitor?.signals,
    toolFailureStreak: brainCfg?.monitor?.toolFailureStreak,
    errorStormCount: brainCfg?.monitor?.errorStormCount,
    errorStormWindowMs: brainCfg?.monitor?.errorStormWindowMs,
    stallMs: brainCfg?.monitor?.stallMs,
    stallCheckIntervalMs: brainCfg?.monitor?.stallCheckIntervalMs,
    fileChurnThreshold: brainCfg?.monitor?.fileChurnThreshold,
    fileChurnWindowMs: brainCfg?.monitor?.fileChurnWindowMs,
    fileEditTools: brainCfg?.monitor?.fileEditTools,
    cooldownMs: brainCfg?.monitor?.cooldownMs,
    sessionId: () => context.session?.id ?? session.id,
    // Filter out subagent events so the BrainMonitor only monitors the
    // leader's own activity — subagent tool failures or stalls must not
    // trigger corrective steers to the leader agent.
    leaderSessionId: () => context.session?.id ?? session.id,
    intervene: async ({
      subject,
      body,
      sessionId,
    }: {
      subject: string;
      body: string;
      sessionId?: string | undefined;
    }) => {
      // Steer the session whose distress triggered this. The CLI host runs one
      // session, so this normally resolves to the same id — but taking it from
      // the signal rather than from a captured `session` keeps the steer
      // correct across a session swap that lands mid-engagement.
      const tag = mailboxSessionTag(sessionId || context.session?.id || session.id);
      const leaderUniqueId = `leader@${tag}`;
      await brainMailbox.send({
        from: `brain@${tag}`,
        to: leaderUniqueId,
        type: 'steer',
        subject,
        body,
        priority: 'high',
      });
    },
  });
  brainMonitor.start();
  teardownHandlers.push(() => brainMonitor?.stop());
  teardownHandlers.push(() => brainQueue.dispose());

  // ── Shadow controller ────────────────────────────────────────────────────
  let shadowDefaults: { intervalMs?: number; provider?: string; model?: string } = {};
  const shadowController = {
    activeId: null as string | null,
    register(id: string) {
      this.activeId = id;
    },
    clear() {
      this.activeId = null;
    },
    getDefaults() {
      return { ...shadowDefaults };
    },
    setDefaults(defaults: { intervalMs?: number; provider?: string; model?: string }) {
      shadowDefaults = { ...shadowDefaults, ...defaults };
    },
  };

  // ── MultiAgentHost ───────────────────────────────────────────────────────
  const multiAgentHost = new MultiAgentHost(
    {
      container,
      toolRegistry,
      providerRegistry,
      configStore,
      modelsRegistry,
      fallbackProfileManager: container.resolve(TOKENS.FallbackProfileManager),
      events,
      systemPromptBuilder: promptBuilder,
      session,
      tokenCounter,
      projectRoot,
      cwd,
      skillLoader,
      tracer: deps.tracer,
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      // WrongTrace lock gate for every spawned worker — same fail-open
      // coordination the leader's executor enforces (lifecycle-plugins).
      // Registered unconditionally to mirror the leader registration.
      // Dedicated runner: shell hooks from config.hooks stay leader-only.
      // Gate-decision events fan out on the host EventBus so deny/allow/
      // lock transitions are observable from the CLI.
      hookRunner: createSubagentWrongTraceHookRunner(
        () => session.id,
        (event) => {
          // Same firing-rate tally as the leader emit site (lifecycle-plugins).
          recordGateDecision(event);
          events.emit('wrongtrace.gate.decision', event);
        },
      ),
      ...(installToolBoundary ? { installToolBoundary } : {}),
    },
    {
      manifestPath,
      sharedScratchpadPath,
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
      fleetRoot: fleetRootForPromotion,
      stateCheckpointPath,
      sessionWriter: session,
      ...(config.fleet?.budget
        ? {
            directorBudget: {
              maxTokens: config.fleet.budget.maxTokens,
              maxCostUsd: config.fleet.budget.maxCostUsd,
            },
          }
        : {}),
      maxSpawns: deps.maxSpawns ?? config.fleet?.budget?.maxSpawns,
      maxConcurrent,
      budgetSources: {
        maxConcurrent: deps.maxConcurrentSource ?? 'default',
        maxSpawns: deps.maxSpawnsSource ?? 'default',
      },
      getLeaderMaxContext: () => effectiveMaxContextRef.current,
      brain,
      agentMonitor,
      traceId: sessResult.traceId,
      onShadowAgentStarted: (subagentId: string) => shadowController.register(subagentId),
      onShadowAgentStopped: (subagentId: string) => {
        if (shadowController.activeId === subagentId) shadowController.clear();
      },
      ...(deps.modeId ? { getLeaderMode: () => deps.modeId } : {}),
      ...(deps.statusTracker ? { statusTracker: deps.statusTracker } : {}),
    },
  );

  // Background delegation tracker — one per host process. Follows every
  // non-blocking `delegate` to settlement and queues its result for the owning
  // leader. Aborted on host teardown; a session fleet stop reaches it through
  // `Director.terminateSession` (the tracker subscribes per director).
  const delegationTracker = new DelegationTracker({ events });
  container.bind(TOKENS.DelegationTracker, () => delegationTracker);
  teardownHandlers.push(() => delegationTracker.dispose());
  // Boot `--resume`: re-queue background results the previous process never
  // delivered (never wakes — see DelegationTracker.rehydrate).
  try {
    const restoredEvents = (sessResult as { restoredEvents?: unknown }).restoredEvents;
    if (Array.isArray(restoredEvents) && restoredEvents.length > 0) {
      delegationTracker.rehydrate(session.id, restoredEvents);
    }
  } catch {
    /* rehydration is best-effort; resume itself already succeeded */
  }

  // The machine's WrongForge, when set up: offered to the leader with the models it serves.
  const wrongForge = wrongForgeDelegateEntry();
  // Delegate tool — Director Mode is permanently on.
  toolRegistry.register(
    createDelegateTool({
      host: multiAgentHost,
      roster: multiAgentHost.getRoster(),
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
      events,
      tracker: delegationTracker,
      // Temporary rollback switch (user config only — `fleet` is denied in
      // project config). Read live so a settings change applies next call.
      defaultWait: () => {
        try {
          return configStore.get()?.fleet?.delegate?.defaultWait;
        } catch {
          return undefined;
        }
      },
      // A task with no tier, model or role route gets a System One pick among
      // the configured `modelTiers` levels; off/unconfigured/resting = the
      // routing-table default, as before.
      suggestTier: createSystemOneTierSuggester({
        getConfig: () => (configStore.get?.() as Config | undefined) ?? config,
        getJudge: () =>
          resolveTypeSafeJudge({
            config: (configStore.get?.() as Config | undefined) ?? config,
            feature: 'modelTier',
            logger: container.safeResolve(TOKENS.Logger),
          }),
      }),
      externalAgents: [
        ...installedBridgeAgents(config.acp),
        ...(wrongForge ? [wrongForge.agent] : []),
      ],
      ...(wrongForge?.models
        ? { externalAgentModels: { [wrongForge.agent]: wrongForge.models } }
        : {}),
      // Live config: tiers, routes and providers the leader can actually pick.
      modelMenu: () => {
        const live = (configStore.get?.() as Config | undefined) ?? config;
        return renderLeaderModelMenu(live, { provider: live.provider, model: live.model });
      },
    }),
  );
  toolRegistry.exposeToProvider('delegate');

  // The Director's canonical toolset owns define_subagent registration during
  // activation. Marking a future name as direct is supported by ToolRegistry
  // and avoids registering the same tool in two boot phases.
  toolRegistry.exposeToProvider('define_subagent');

  // mcp_control tool
  toolRegistry.register(
    createMcpControlTool({
      getConfig: () => configStore.get(),
      configPath: profileConfigPath,
      registry: mcpRegistry,
    }),
  );
  if (normalizeTokenSavingTier(config.features.tokenSavingMode) !== 'off') {
    toolRegistry.exposeToProvider('mcp_control');
  }

  // Stable MCP gateway. Keep it registered even in full/direct mode because
  // roster capabilities and skills refer to the gateway, never to a specific
  // server's dynamic `mcp__...` tool name.
  toolRegistry.register(
    createMcpUseTool({
      registry: mcpRegistry,
      toolRegistry,
    }),
  );
  if (normalizeTokenSavingTier(config.features.tokenSavingMode) !== 'off') {
    toolRegistry.exposeToProvider('mcp_use');
  }

  // The model titles the session it works in. The store is resolved per call:
  // this phase runs before the session is established.
  toolRegistry.register(
    createSessionRenameTool({
      rename: (sessionId, name) => container.resolve(TOKENS.SessionStore).rename(sessionId, name),
      events,
    }),
  );
  if (normalizeTokenSavingTier(config.features.tokenSavingMode) !== 'off') {
    toolRegistry.exposeToProvider(SESSION_RENAME_TOOL_NAME);
  }

  return {
    brain,
    brainLog,
    brainTierStats,
    brainSettings,
    brainRuntime,
    brainQueue,
    multiAgentHost,
    shadowController,
    shadowDefaults,
  };
}
