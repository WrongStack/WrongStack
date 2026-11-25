import type { RunTurnApi } from '@wrongstack/acp/agent';
import { TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, UserInputAwaiter } from '@wrongstack/contracts/types';
import {
  createDelegateTool,
  DelegationTracker,
  renderLeaderModelMenu,
} from '@wrongstack/coordination';
import { sessionScopedPath } from '@wrongstack/core/utils';
import {
  installedBridgeAgents,
  type MultiAgentDeps,
  MultiAgentHost,
  resolveFleetBudgetSources,
} from '@wrongstack/fleet';

type AcpDelegationDependencies = Pick<
  MultiAgentDeps,
  | 'container'
  | 'events'
  | 'providerRegistry'
  | 'toolRegistry'
  | 'tokenCounter'
  | 'session'
  | 'projectRoot'
  | 'modelsRegistry'
>;

export function installAcpNativeDelegation(options: {
  deps: AcpDelegationDependencies;
  config: Config;
  flags?: Record<string, string | boolean> | undefined;
  sessionsDir: string;
  api?: RunTurnApi | undefined;
  authorizeSubagentTool?: MultiAgentDeps['authorizeSubagentTool'];
  userInputAwaiter: UserInputAwaiter;
}): () => Promise<void> {
  const { deps, config, api, sessionsDir, authorizeSubagentTool, userInputAwaiter } = options;
  const { container, events, projectRoot, session, toolRegistry } = deps;
  if (toolRegistry.get('delegate')) return async () => {};
  const configStore = container.resolve(TOKENS.ConfigStore);
  const budget = config.fleet?.budget;
  const limits = resolveFleetBudgetSources({ config, flags: options.flags });
  const host = new MultiAgentHost(
    {
      ...deps,
      cwd: projectRoot,
      configStore,
      // ACP uses its caller's prompt. The fleet factory supplies the worker
      // baseline and role even when the interactive prompt builder is absent.
      systemPromptBuilder: container.safeResolve(TOKENS.SystemPromptBuilder) ?? {
        build: async () => [],
      },
      fallbackProfileManager: container.resolve(TOKENS.FallbackProfileManager),
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
      skillLoader: container.safeResolve(TOKENS.SkillLoader),
      authorizeSubagentTool,
      subagentUserInputAwaiter: userInputAwaiter,
    },
    {
      directorRunId: session.id,
      fleetRoot: sessionScopedPath(sessionsDir, session.id, '.fleet'),
      sessionWriter: session,
      maxConcurrent: limits.maxConcurrent,
      maxSpawns: limits.maxSpawns,
      budgetSources: {
        maxConcurrent: limits.maxConcurrentSource,
        maxSpawns: limits.maxSpawnsSource,
      },
      ...(budget
        ? { directorBudget: { maxTokens: budget.maxTokens, maxCostUsd: budget.maxCostUsd } }
        : {}),
      getLeaderMode: () => api?.currentModeId?.(),
      retireSubagentOnTaskComplete: true,
    },
  );
  const tracker = new DelegationTracker({ events });
  toolRegistry.register(
    createDelegateTool({
      host,
      roster: host.getRoster(),
      tracker,
      events,
      externalAgents: installedBridgeAgents(config.acp),
      defaultWait: () => configStore.get().fleet?.delegate?.defaultWait,
      modelMenu: () => {
        const live = configStore.get();
        return renderLeaderModelMenu(live, { provider: live.provider, model: live.model });
      },
      backgroundNote:
        'The result will be available to the leader during its next prompt if this turn ends first.',
    }),
  );
  toolRegistry.exposeToProvider('delegate');
  return async () => {
    tracker.dispose();
    await host.dispose();
  };
}
