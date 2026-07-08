import {
  type BrainAutoRisk,
  BrainDecisionQueue,
  BrainMonitor,
  type Config,
  createAutonomyBrain,
  createDelegateTool,
  createMcpControlTool,
  createMcpUseTool,
  createTieredBrainArbiter,
  DefaultBrainArbiter,
  FLEET_ROSTER,
  HumanEscalatingBrainArbiter,
  ObservableBrainArbiter,
  type Provider,
  type SessionWriter,
  TOKENS,
  type ToolRegistry,
} from '@wrongstack/core';
import { MultiAgentHost } from '../multi-agent.js';
import { subscribeBrainDecisionLog } from '../boot/brain-decision-log.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: large dep bag
type AnyObj = any;

export interface BrainOrchestrationDeps {
  events: AnyObj;
  config: Config;
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
  brainSettings: { maxAutoRisk: BrainAutoRisk };
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

  // ── Global Brain chain — policy → LLM → human ──────────────────────────
  const brainSettings: { maxAutoRisk: BrainAutoRisk } = {
    maxAutoRisk: 'medium',
  };
  const brainQueue = new BrainDecisionQueue(events);
  const autonomousBrain = {
    decide: (request: AnyObj) =>
      createAutonomyBrain({
        provider,
        model: config.model,
        maxAutoRisk: 'all',
      }).decide(request),
  };
  const brain = new ObservableBrainArbiter(
    new HumanEscalatingBrainArbiter(
      createTieredBrainArbiter({
        policy: new DefaultBrainArbiter(),
        autonomous: autonomousBrain,
        getMaxAutoRisk: () => brainSettings.maxAutoRisk,
      }),
      brainQueue,
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
    sessionId: () => context.session?.id ?? session.id,
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

  // Delegate tool
  toolRegistry.register(
    createDelegateTool({
      host: multiAgentHost,
      roster: FLEET_ROSTER,
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
      events,
    }),
  );

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
    brainQueue,
    multiAgentHost,
    shadowController,
    shadowDefaults,
  };
}
