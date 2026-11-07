import { join } from 'node:path';
import { type Container, type EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type {
  Config,
  ModelsRegistry,
  SessionWriter,
  SkillLoader,
  Tracer,
} from '@wrongstack/contracts/types';
import {
  createDelegateTool,
  createSystemOneTierSuggester,
  DelegationTracker,
  LeaderAutoWakeController,
  renderLeaderModelMenu,
} from '@wrongstack/coordination';
import type { AgentPipelines } from '@wrongstack/core/agent';
import { HookRegistry, HookRunner } from '@wrongstack/core/hooks';
import type { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import type { ProviderRegistry, ToolRegistry } from '@wrongstack/core/registry';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';
import { sessionScopedPath } from '@wrongstack/core/utils';
import {
  installedBridgeAgents,
  MultiAgentHost,
  resolveFleetBudgetSources,
} from '@wrongstack/fleet';
import { createWrongTraceHookPair, recordGateDecision } from '@wrongstack/wrongtrace';
import {
  createWebuiLeaderAutoWakeHost,
  type WebuiLeaderAutoWakeHost,
  type WebuiLeaderAutoWakeHostOptions,
} from './leader-auto-wake-host.js';

/** Tools that mutate a single target file; same matcher as the leader's gate. */
const WRONGTRACE_MATCHER = 'edit|write|replace|patch|codebase-ast-replace';

export interface StandaloneDelegationInput {
  container: Container;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  modelsRegistry: ModelsRegistry;
  events: EventBus;
  tokenCounter: DefaultTokenCounter;
  skillLoader: SkillLoader | undefined;
  tracer: Tracer | undefined;
  installToolBoundary?: ((pipelines: AgentPipelines) => void) | undefined;
  config: Config;
  getConfig: () => Config;
  projectRoot: string;
  cwd: string;
  projectSessionsDir: string;
  /** The boot session: the fleet's run id and the journal subagent events go to. */
  session: SessionWriter;
}

/**
 * The engine process's auto-wake: starts a turn for an idle leader when something it was
 * promised arrives — a background `delegate` result, or a runtime notice it asked for
 * (`session_wakeup` timer, `process_watch` output, background shell exit). It exists
 * whether or not `delegate` is enabled: timers and watches need it too.
 */
export interface StandaloneAutoWake {
  /**
   * Binds the engine's conversation path. Called once the run locks, pending confirms and
   * client map exist; a second call replaces the first binding.
   */
  attachAutoWake(
    options: Omit<WebuiLeaderAutoWakeHostOptions, 'controller' | 'events'>,
  ): WebuiLeaderAutoWakeHost;
  dispose(): void;
}

/**
 * The engine process's only auto-wake controller: the CLI never boots this path (it hosts
 * the WebUI through its own agent and controller), so this cannot double-wake a session.
 * The engine creates exactly one — through `installStandaloneDelegation` when `delegate`
 * is installed, otherwise directly in `createAgentServices`.
 */
export function createStandaloneAutoWake(input: {
  events: EventBus;
  getConfig: () => Config;
}): StandaloneAutoWake {
  const controller = new LeaderAutoWakeController({
    events: input.events,
    config: () => input.getConfig().fleet?.delegate,
  });
  let wakeHost: WebuiLeaderAutoWakeHost | undefined;
  return {
    attachAutoWake: (options) => {
      wakeHost?.dispose();
      wakeHost = createWebuiLeaderAutoWakeHost({ ...options, controller, events: input.events });
      return wakeHost;
    },
    dispose: () => {
      wakeHost?.dispose();
      controller.dispose();
    },
  };
}

export interface StandaloneDelegation {
  host: MultiAgentHost;
  tracker: DelegationTracker;
  /**
   * Binds the engine's conversation path so a settled background delegation starts a turn
   * for an idle leader (the delegate tool promises that). Called once the run locks, pending
   * confirms and client map exist; a second call replaces the first binding.
   */
  attachAutoWake(
    options: Omit<WebuiLeaderAutoWakeHostOptions, 'controller' | 'events'>,
  ): WebuiLeaderAutoWakeHost;
  /**
   * Stop a conversation's workers with its run (CLI parity: `execution-webui.ts`): the
   * session's fleet plus the worker ids the page showed. Scoped, so one tab's Stop never
   * reaches another tab's workers.
   */
  stopSession(sessionId: string, subagentIds?: readonly string[]): Promise<void> | undefined;
  dispose(): Promise<void>;
}

/**
 * The `delegate` tool for the standalone engine (CLI parity: `brain-and-orchestration.ts`).
 * One fleet host per engine process, namespaced under the boot session like the CLI-hosted
 * WebUI; background results reach the calling tab's leader through the delivery hub, which
 * every agent loop drains. Returns undefined, registering nothing, when `delegate` is in
 * `tools.disabledTools` (the canonical registration's disable pass ran before this late one)
 * or the container lacks the services the host needs.
 */
export function installStandaloneDelegation(
  input: StandaloneDelegationInput,
): StandaloneDelegation | undefined {
  const { container, toolRegistry, events, config } = input;
  if ((config.tools?.disabledTools ?? []).includes('delegate')) return undefined;
  const configStore = container.safeResolve(TOKENS.ConfigStore);
  const systemPromptBuilder = container.safeResolve(TOKENS.SystemPromptBuilder);
  const fallbackProfileManager = container.safeResolve(TOKENS.FallbackProfileManager);
  if (!configStore || !systemPromptBuilder || !fallbackProfileManager) return undefined;

  const sessionId = input.session.id;
  const fleetRoot = sessionScopedPath(input.projectSessionsDir, sessionId, '');
  const sessionsRoot = join(fleetRoot, 'subagents');
  const budget = resolveFleetBudgetSources({ config });

  // Workers get only the fail-open WrongTrace lock gate, never the leader's shell hooks.
  const hookRegistry = new HookRegistry();
  const hooks = createWrongTraceHookPair(() => input.session.id, {
    emit: (event) => {
      recordGateDecision(event);
      events.emit('wrongtrace.gate.decision', event);
    },
  });
  hookRegistry.registerInProcess(
    'PreToolUse',
    WRONGTRACE_MATCHER,
    hooks.preToolUse,
    'wrongtrace-gate',
  );
  hookRegistry.registerInProcess(
    'PostToolUse',
    WRONGTRACE_MATCHER,
    hooks.postToolUse,
    'wrongtrace-gate',
    {
      runWhenToolSkipped: true,
    },
  );

  const host = new MultiAgentHost(
    {
      container,
      toolRegistry,
      providerRegistry: input.providerRegistry,
      configStore,
      modelsRegistry: input.modelsRegistry,
      fallbackProfileManager,
      events,
      systemPromptBuilder,
      session: input.session,
      tokenCounter: input.tokenCounter,
      projectRoot: input.projectRoot,
      cwd: input.cwd,
      skillLoader: input.skillLoader,
      tracer: input.tracer,
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      hookRunner: new HookRunner({
        registry: hookRegistry,
        sessionId: () => input.session.id,
        allowNonPolicy: true,
      }),
      ...(input.installToolBoundary ? { installToolBoundary: input.installToolBoundary } : {}),
    },
    {
      manifestPath: join(fleetRoot, 'fleet.json'),
      sharedScratchpadPath: join(fleetRoot, 'shared'),
      sessionsRoot,
      directorRunId: sessionId,
      fleetRoot,
      stateCheckpointPath: join(fleetRoot, 'director-state.json'),
      sessionWriter: input.session,
      ...(config.fleet?.budget
        ? {
            directorBudget: {
              maxTokens: config.fleet.budget.maxTokens,
              maxCostUsd: config.fleet.budget.maxCostUsd,
            },
          }
        : {}),
      maxSpawns: budget.maxSpawns,
      maxConcurrent: budget.maxConcurrentSource === 'default' ? undefined : budget.maxConcurrent,
      budgetSources: {
        maxConcurrent: budget.maxConcurrentSource,
        maxSpawns: budget.maxSpawnsSource,
      },
      statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker),
    },
  );

  const tracker = new DelegationTracker({ events });
  if (!container.has(TOKENS.DelegationTracker))
    container.bind(TOKENS.DelegationTracker, () => tracker);

  toolRegistry.register(
    createDelegateTool({
      host,
      roster: host.getRoster(),
      sessionsRoot,
      directorRunId: sessionId,
      events,
      tracker,
      defaultWait: () => input.getConfig().fleet?.delegate?.defaultWait,
      suggestTier: createSystemOneTierSuggester({
        getConfig: input.getConfig,
        getJudge: () =>
          resolveTypeSafeJudge({
            config: input.getConfig(),
            feature: 'modelTier',
            logger: container.safeResolve(TOKENS.Logger),
          }),
      }),
      // WrongForge workers need the CLI's in-process tool gateway, so only installed ACP
      // agents are offered here.
      externalAgents: installedBridgeAgents(config.acp),
      modelMenu: () => {
        const live = input.getConfig();
        return renderLeaderModelMenu(live, { provider: live.provider, model: live.model });
      },
    }),
  );
  toolRegistry.exposeToProvider('delegate');

  const autoWake = createStandaloneAutoWake({ events, getConfig: input.getConfig });

  return {
    host,
    tracker,
    attachAutoWake: (options) => autoWake.attachAutoWake(options),
    stopSession: (stoppedSessionId, subagentIds) => {
      const director = host.getDirector();
      if (!director) return undefined;
      const shown = (subagentIds ?? []).filter((id) => id.length > 0 && id !== 'leader');
      return Promise.all([
        director.terminateSession(stoppedSessionId),
        ...shown.map((id) => director.terminate(id).catch(() => undefined)),
      ]).then(() => undefined);
    },
    dispose: async () => {
      autoWake.dispose();
      tracker.dispose();
      await host.dispose();
    },
  };
}
