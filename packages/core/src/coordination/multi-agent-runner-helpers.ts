import type {
  SubagentConfig,
  SubagentRunContext,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import { classifySubagentError } from './coordinator/error-classifier.js';
import { isExternalAgentProvider } from './external-agent-provider.js';
import type { SubagentEntry } from './multi-agent-queue-helpers.js';
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
  const { subagentConfig, subagentId, sessionOf, applyRosterBudget } = params;
  // The coordinator's defaults are for its own workers. ACP workers run an
  // external loop; keep their explicit limits and ACP inactivity default.
  const defaultBudget = isExternalAgentProvider(subagentConfig.provider)
    ? undefined
    : params.defaultBudget;
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
  parentBridge: import('@wrongstack/contracts/types/agent-bridge').AgentBridge | null;
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
  let latestPartial:
    | import('@wrongstack/contracts/types/multi-agent').SubagentPartialResult
    | undefined;

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

/**
 * Final race guard: if `stop(subagentId)` ran between dispatch
 * and us arriving here, refuse to start the task and surface it
 * as `aborted_by_parent` so any caller awaiting the task id
 * unblocks. Without this, the task would be marked 'running',
 * collide with the just-completed 'stopped' state, and leak
 * inFlight by 1 because no recordCompletion path covers it.
 */
export function createTerminatedBeforeStartResult(subagentId: string, taskId: string): TaskResult {
  return {
    subagentId,
    taskId,
    status: 'stopped',
    error: {
      kind: 'aborted_by_parent',
      message: 'Subagent was terminated before task could start',
      retryable: false,
    },
    iterations: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

/** Mark `subagent` running on `task` and record it in its bounded task history. */
export function beginSubagentTask(
  subagent: SubagentEntry,
  subagentId: string,
  task: TaskSpec,
  maxHistory: number,
): void {
  subagent.status = 'running';
  subagent.currentTask = task.id;
  task.subagentId = subagentId;
  // Carry the owning session on the task itself. Agent factories receive
  // `(config, task)` and nothing else, so without this the only session they
  // could read was the HOST's live one — which moves every time the user
  // switches tabs, filing a worker's transcript and token spend under
  // whichever tab happened to be in front when it spawned. An explicit
  // stamp on the task already wins; this only fills the gap.
  if (subagent.sessionId) {
    task.context = { sessionId: subagent.sessionId, ...(task.context ?? {}) };
  }
  subagent.context.tasks.push(task);
  // Bound the per-subagent task history: a worker runs one task at a time, so
  // the completing task is always among the most recent entries. This keeps a
  // long-lived worker (idle→assign→complete→…) from accumulating every task it
  // ever ran, and keeps the `.find` at recordCompletion O(cap) instead of O(N).
  if (subagent.context.tasks.length > maxHistory) {
    subagent.context.tasks.splice(0, subagent.context.tasks.length - maxHistory);
  }
}
