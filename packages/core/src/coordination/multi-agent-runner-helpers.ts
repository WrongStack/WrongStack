import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import { classifySubagentError } from './coordinator/error-classifier.js';
import { executeSubagentWithTimeout } from './multi-agent-timeout.js';
import type { SubagentBudget } from './subagent-budget.js';
import { BudgetExceededError, SubagentBudget as BudgetImpl } from './subagent-budget.js';
import { resolveGracefulFinish } from './subagent-finish.js';

export interface CreateSubagentBudgetParams {
  subagentConfig: SubagentConfig;
  defaultBudget?:
    | {
        maxIterations?: number | undefined;
        maxToolCalls?: number | undefined;
        maxTokens?: number | undefined;
        maxCostUsd?: number | undefined;
        timeoutMs?: number | undefined;
        idleTimeoutMs?: number | undefined;
      }
    | undefined;
  subagentId: string;
  sessionOf: (id: string) => string;
  applyRosterBudget: (cfg: SubagentConfig) => SubagentConfig;
}

export function createSubagentTaskBudget(params: CreateSubagentBudgetParams): SubagentBudget {
  const { subagentConfig, defaultBudget, subagentId, sessionOf } = params;
  const rawMaxIterations = subagentConfig.maxIterations;
  const rawMaxToolCalls = subagentConfig.maxToolCalls;
  const rawMaxTokens = subagentConfig.maxTokens;
  const rawMaxCostUsd = subagentConfig.maxCostUsd;
  const rawTimeoutMs = subagentConfig.timeoutMs;
  const rawIdleTimeoutMs = subagentConfig.idleTimeoutMs;
  const configWithRosterDefaults = applyRosterBudget(subagentConfig);

  return new BudgetImpl(
    {
      maxIterations:
        rawMaxIterations ?? defaultBudget?.maxIterations ?? configWithRosterDefaults.maxIterations,
      maxToolCalls:
        rawMaxToolCalls ?? defaultBudget?.maxToolCalls ?? configWithRosterDefaults.maxToolCalls,
      maxTokens: rawMaxTokens ?? defaultBudget?.maxTokens ?? configWithRosterDefaults.maxTokens,
      maxCostUsd: rawMaxCostUsd ?? defaultBudget?.maxCostUsd ?? configWithRosterDefaults.maxCostUsd,
      timeoutMs: rawTimeoutMs ?? defaultBudget?.timeoutMs ?? configWithRosterDefaults.timeoutMs,
      idleTimeoutMs:
        rawIdleTimeoutMs ?? defaultBudget?.idleTimeoutMs ?? configWithRosterDefaults.idleTimeoutMs,
    },
    'auto',
    {
      sessionId: () => sessionOf(subagentId),
      subagentId,
      ...(resolveGracefulFinish(subagentConfig) ? { wallClockWatchdogOwned: true } : {}),
    },
  );
}

export interface ExecuteSubagentTaskParams {
  runner: SubagentRunner;
  task: TaskSpec;
  subagentId: string;
  config: SubagentConfig;
  budget: SubagentBudget;
  abortController: AbortController;
  sessionId: string;
  parentBridge: import('../types/agent-bridge.js').AgentBridge | null;
  abortSubagent: (id: string) => void;
  sessionOf: (id: string) => string;
}

export async function executeSubagentTask(params: ExecuteSubagentTaskParams): Promise<TaskResult> {
  const {
    runner,
    task,
    subagentId,
    config,
    budget,
    abortController,
    sessionId,
    parentBridge,
    abortSubagent,
    sessionOf,
  } = params;

  const startTime = Date.now();
  let latestPartial: import('../types/multi-agent.js').SubagentPartialResult | undefined;

  const runCtx: SubagentRunContext = {
    subagentId,
    config,
    budget,
    signal: abortController.signal,
    sessionId,
    bridge: parentBridge,
    reportProgress: (partial) => {
      const text = partial.text.trim();
      if (!text) return;
      latestPartial = {
        ...partial,
        text: text.slice(-4_000),
      };
    },
  };

  budget.start();
  try {
    const outcome = await executeSubagentWithTimeout({
      runner,
      task,
      ctx: runCtx,
      budget,
      preemptFraction: config.preemptFraction,
      gracefulFinish: resolveGracefulFinish(config),
      abortSubagent,
      currentSessionId: () => sessionOf(runCtx.subagentId),
    });

    return {
      subagentId,
      taskId: task.id,
      status: 'success',
      result: outcome.result,
      ...(outcome.report ? { report: outcome.report } : {}),
      iterations: outcome.iterations,
      toolCalls: outcome.toolCalls,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    const status: TaskResult['status'] =
      err instanceof BudgetExceededError && (err.kind === 'timeout' || err.kind === 'idle_timeout')
        ? 'timeout'
        : abortController.signal.aborted
          ? 'stopped'
          : 'failed';
    const usage = budget.usage();
    return {
      subagentId,
      taskId: task.id,
      status,
      error: classifySubagentError(err, {
        parentAborted: abortController.signal.aborted,
      }),
      ...(latestPartial ? { partial: latestPartial } : {}),
      iterations: usage.iterations,
      toolCalls: usage.toolCalls,
      durationMs: Date.now() - startTime,
    };
  }
}
