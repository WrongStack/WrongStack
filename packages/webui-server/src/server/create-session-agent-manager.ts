import { DEFAULT_TOOLS_CONFIG } from '@wrongstack/contracts/types';
import { Agent, Context } from '@wrongstack/core/agent';

import { createSessionAgentRegistry, createSessionTokenCounter } from './session-agent-registry.js';

export function createSessionAgentManager({
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
  toolExecutor,
}: {
  agent: import('@wrongstack/core/agent').Agent;
  MAX_CONCURRENT_SESSION_AGENTS: 4;
  input: {
    isRunActive?: ((sessionId: string) => boolean) | undefined;
    isDisplayed?: ((sessionId: string) => boolean) | undefined;
    tokenCounter: import('@wrongstack/core/infrastructure').DefaultTokenCounter;
  };
  projectRoot: string;
  workingDir: string;
  context: import('@wrongstack/core/agent').Context;
  modelsRegistry: import('@wrongstack/contracts/types').ModelsRegistry;
  container: import('@wrongstack/contracts/kernel').Container;
  toolRegistry: import('@wrongstack/core/registry').ToolRegistry;
  providerRegistry: import('@wrongstack/core/registry').ProviderRegistry;
  events: import('@wrongstack/contracts/kernel').EventBus;
  pipelines: import('@wrongstack/core/agent').AgentPipelines;
  config: import('@wrongstack/contracts/types').Config;
  toolExecutor: import('@wrongstack/core/execution').ToolExecutor;
}) {
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
        session: { id: sessionId, traceId: context.traceId } as Awaited<
          ReturnType<import('@wrongstack/contracts/types').SessionStore['create']>
        >,
        traceId: context.traceId,
        systemPrompt: context.systemPrompt,
        agentId: 'leader',
        agentName: 'Leader Agent',
        allowOutsideProjectRoot: context.allowOutsideProjectRoot,
        signal: context.signal,
        userInputAwaiter: context.userInputAwaiter,
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
        tracer: agent.tracer,
      });
    },
  });
  return { sessionAgents };
}
