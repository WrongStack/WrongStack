import type { TaskResult } from '../types/multi-agent.js';
import type { FleetBus } from './fleet-bus.js';
import type { SubagentEntry } from './multi-agent-queue-helpers.js';

export interface RecordCompletionStateParams {
  result: TaskResult;
  subagents: Map<string, SubagentEntry>;
  terminating: Set<string>;
  inFlight: number;
  runner: unknown;
  fleetBus?: FleetBus | undefined;
  sessionOf: (subagentId: string) => string;
  emitWarning: (warning: { type: string; taskId: string; subagentId: string }) => void;
}

export interface RecordCompletionOutcome {
  nextInFlight: number;
  underflow: boolean;
  taskObj: { id: string };
  completedSessionId: string;
}

export function handleRecordCompletionState(
  params: RecordCompletionStateParams,
): RecordCompletionOutcome {
  const { result, subagents, terminating, inFlight, runner, fleetBus, sessionOf, emitWarning } =
    params;

  let nextInFlight = inFlight;
  if (nextInFlight > 0) {
    nextInFlight--;
  } else if (runner) {
    emitWarning({
      type: 'inFlight_underflow',
      taskId: result.taskId,
      subagentId: result.subagentId,
    });
    return {
      nextInFlight,
      underflow: true,
      taskObj: { id: result.taskId },
      completedSessionId: sessionOf(result.subagentId),
    };
  }

  const subagent = subagents.get(result.subagentId);
  if (subagent && subagent.status !== 'stopped') {
    subagent.status = 'idle';
    subagent.currentTask = undefined;
    if (subagent.abortController.signal.aborted) {
      subagent.abortController = new AbortController();
    }

    fleetBus?.emit({
      subagentId: result.subagentId,
      ts: Date.now(),
      type: 'subagent.idle',
      payload: {
        sessionId: subagent.sessionId,
        subagentId: result.subagentId,
      },
    });
  }

  terminating.delete(result.subagentId);

  const taskObj = subagent?.context.tasks.find((t) => t.id === result.taskId) ?? {
    id: result.taskId,
  };
  const completedSessionId = sessionOf(result.subagentId);

  fleetBus?.emit({
    subagentId: result.subagentId,
    taskId: result.taskId,
    ts: Date.now(),
    type: 'subagent.completed',
    payload: {
      sessionId: completedSessionId,
      subagentId: result.subagentId,
      taskId: result.taskId,
      status: result.status,
      result: result.result,
      report: result.report,
      partial: result.partial,
      iterations: result.iterations,
      toolCalls: result.toolCalls,
      durationMs: result.durationMs,
    },
  });

  return {
    nextInFlight,
    underflow: false,
    taskObj,
    completedSessionId,
  };
}

export function pushAndTrimCompletedResult(
  results: TaskResult[],
  byId: Map<string, TaskResult>,
  result: TaskResult,
  maxResults: number,
): void {
  results.push(result);
  byId.set(result.taskId, result);
  if (results.length > maxResults) {
    const dropCount = results.length - maxResults;
    const dropped = results.splice(0, dropCount);
    for (const item of dropped) {
      if (byId.get(item.taskId) === item) {
        byId.delete(item.taskId);
      }
    }
  }
}

export function isCoordinatorDone(
  condition: { type: string; maxIterations?: number | undefined },
  pendingTasksCount: number,
  inFlight: number,
  totalIterations: number,
): boolean {
  if (condition.type === 'all_tasks_done') {
    return pendingTasksCount === 0 && inFlight === 0;
  }
  if (condition.maxIterations !== undefined && totalIterations >= condition.maxIterations) {
    return true;
  }
  return false;
}
