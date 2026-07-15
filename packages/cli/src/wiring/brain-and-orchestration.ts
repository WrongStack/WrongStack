import { join } from 'node:path';
import {
  type BrainAutoRisk,
  BrainDecisionLedger,
  BrainDecisionQueue,
  type BrainEscalationMode,
  BrainMonitor,
  type BrainRuntime,
  type Config,
  createBrainRuntime,
  createDelegateTool,
  createMcpControlTool,
  createMcpUseTool,
  EscalationRoutingBrainArbiter,
  FLEET_ROSTER,
  ObservableBrainArbiter,
  type Provider,
  resolveBrainConfigDefaults,
  type SecretVault,
  type SessionWriter,
  terminalPolicyDecision,
  TOKENS,
  type ToolRegistry,
} from '@wrongstack/core';
import { persistConfigSetting } from '../settings-menu.js';
import { buildProviderForId } from './provider-runtime.js';
import { MultiAgentHost } from '../multi-agent.js';
import { subscribeBrainDecisionLog } from '../boot/brain-decision-log.js';

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

export interface BrainOrchestrationDeps {
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
  projectRoot: string;
  cwd: string;
  wpaths: AnyObj;
  teardownHandlers: (() => void)[];
  mailboxSessionTag: (id: string) => string;
  brainMailbox: AnyObj;
  agentMonitor: AnyObj;
  directorMode: boolean;
  manifestPath: string | undefined;
  sharedScratchpadPath: string | undefined;
  subagentSessionsRoot: string | undefined;
  stateCheckpointPath: string | undefined;
  fleetRootForPromotion: string;
  maxConcurrent: number | undefined;
  effectiveMaxContextRef: { current: number };
  mcpRegistry: AnyObj;
  sessResult: AnyObj;
}

export interface BrainOrchestrationResult {
  brain: ObservableBrainArbiter;
  brainLog: AnyObj[];
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
export function setupBrainAndOrchestration(
  deps: BrainOrchestrationDeps,
): BrainOrchestrationResult {
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
  } = deps;

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
    brainLedger = new BrainDecisionLedger({ events, filePath: ledgerPath });
    void brainLedger.start();
  };
  if (ledgerEnabled) startLedger();
  teardownHandlers.push(() => {
    void brainLedger?.stop();
  });

  // Shared queue options object: BrainDecisionQueue keeps the REFERENCE, so
  // mutating timeoutMs in onApplied makes `/brain human-timeout` live. Do
  // not replace this with a defensive copy in the queue.
  const queueOpts = {
    timeoutMs: brainCfg?.humanTimeoutMs,
    onTimeout: terminalPolicyDecision,
  };
  const brainQueue = new BrainDecisionQueue(events, queueOpts);

  const brainRuntime = createBrainRuntime({
    initialConfig: brainCfg,
    defaultProviderId: config.provider,
    sessionProvider: () => provider,
    sessionModel: () => config.model,
    resolveProvider: (providerId) => buildProviderForId({ config, providerRegistry }, providerId),
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
    // config.brain is denied in project scope (read AND write side), so the
    // persist path always targets ~/.wrongstack/config.json.
    persist: (brainConfig) =>
      persistConfigSetting(
        { configStore, globalConfigPath: wpaths.globalConfig, vault, forceGlobal: true },
        (decrypted) => {
          decrypted['brain'] = brainConfig as never;
        },
      ),
    onApplied: (snapshot) => {
      queueOpts.timeoutMs = snapshot.humanTimeoutMs;
    },
  });

  // Back-compat live settings facade: every existing mutation site
  // (`/brain risk|mode`, the TUI panel, the WebUI brain.risk handler)
  // assigns `brainSettings.maxAutoRisk/mode` — the accessors route those
  // through runtime.apply(), which live-applies AND persists.
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
    new EscalationRoutingBrainArbiter(brainRuntime.arbiter, brainQueue, () =>
      brainRuntime.getMode(),
    ),
    events,
  );
  container.bind(TOKENS.BrainArbiter, () => brain);

  // Decision log for /brain status
  const { brainLog, dispose: disposeBrainLog } = subscribeBrainDecisionLog(events);
  teardownHandlers.push(disposeBrainLog);

  // NOTE: setupHqTelemetry() is called here in cli-main.ts between
  // brain chain and brain monitor. The function continues below.

  // ── Brain Monitor ────────────────────────────────────────────────────────
  const brainMonitor = new BrainMonitor({
    events,
    brain,
    toolFailureStreak: brainCfg?.monitor?.toolFailureStreak,
    errorStormCount: brainCfg?.monitor?.errorStormCount,
    stallMs: brainCfg?.monitor?.stallMs,
    fileChurnThreshold: brainCfg?.monitor?.fileChurnThreshold,
    fileChurnWindowMs: brainCfg?.monitor?.fileChurnWindowMs,
    cooldownMs: brainCfg?.monitor?.cooldownMs,
    sessionId: () => context.session?.id ?? session.id,
    // Filter out subagent events so the BrainMonitor only monitors the
    // leader's own activity — subagent tool failures or stalls must not
    // trigger corrective steers to the leader agent.
    leaderSessionId: () => context.session?.id ?? session.id,
    intervene: async ({ subject, body }: { subject: string; body: string }) => {
      const leaderUniqueId = `leader@${mailboxSessionTag(session.id)}`;
      await brainMailbox.send({
        from: `brain@${mailboxSessionTag(session.id)}`,
        to: leaderUniqueId,
        type: 'steer',
        subject,
        body,
        priority: 'high',
      });
    },
  });
  brainMonitor.start();
  teardownHandlers.push(() => brainMonitor.stop());
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
      events,
      systemPromptBuilder: promptBuilder,
      session,
      tokenCounter,
      projectRoot,
      cwd,
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
    },
    {
      directorMode,
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
      maxSpawns: config.fleet?.budget?.maxSpawns,
      maxConcurrent,
      getLeaderMaxContext: () => effectiveMaxContextRef.current,
      brain,
      agentMonitor,
      traceId: sessResult.traceId,
      onShadowAgentStarted: (subagentId: string) => shadowController.register(subagentId),
      onShadowAgentStopped: (subagentId: string) => {
        if (shadowController.activeId === subagentId) shadowController.clear();
      },
    },
  );

  // Delegate tool is only exposed when Director mode is active. With Director
  // off, subagent/fleet work requires an explicit `/director` promotion first.
  if (directorMode) {
    toolRegistry.register(
      createDelegateTool({
        host: multiAgentHost,
        roster: FLEET_ROSTER,
        sessionsRoot: subagentSessionsRoot,
        directorRunId: session.id,
        events,
      }),
    );
  }

  // mcp_control tool
  toolRegistry.register(
    createMcpControlTool({
      getConfig: () => configStore.get(),
      configPath: wpaths.globalConfig,
      registry: mcpRegistry,
    }),
  );

  // mcp_use tool — meta-tool for token-saving mode
  if (config.features.tokenSavingMode) {
    toolRegistry.register(
      createMcpUseTool({
        registry: mcpRegistry,
        toolRegistry,
      }),
    );
  }

  return {
    brain,
    brainLog,
    brainSettings,
    brainRuntime,
    brainQueue,
    multiAgentHost,
    shadowController,
    shadowDefaults,
  };
}
