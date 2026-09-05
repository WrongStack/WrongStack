import type {
  SubagentConfig,
  SubagentContext,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { SubagentBudget } from './subagent-budget.js';

export type SubagentStatus = 'running' | 'idle' | 'stopped' | 'error';

export interface SubagentEntry {
  config: SubagentConfig;
  context: SubagentContext;
  status: SubagentStatus;
  currentTask?: string | undefined;
  abortController: AbortController;
  activeBudget?: SubagentBudget | undefined;
  sessionId: string;
}

export function findIdleSubagentInMap(
  subagents: Map<string, SubagentEntry>,
  terminating: Set<string>,
): string | null {
  for (const [id, s] of subagents) {
    if (s.status === 'idle' && !terminating.has(id)) return id;
  }
  return null;
}

export function isIdleSubagentInMap(
  subagents: Map<string, SubagentEntry>,
  terminating: Set<string>,
  id: string,
): boolean {
  const subagent = subagents.get(id);
  return !!subagent && subagent.status === 'idle' && !terminating.has(id);
}

export function hasLiveSubagentInMap(
  subagents: Map<string, SubagentEntry>,
  terminating: Set<string>,
): boolean {
  if (subagents.size === 0) return true;
  for (const [id, s] of subagents) {
    if (s.status !== 'stopped' && !terminating.has(id)) return true;
  }
  return false;
}

export function takeNextDispatchableTaskFromQueue(
  pendingTasks: TaskSpec[],
  subagents: Map<string, SubagentEntry>,
  terminating: Set<string>,
): { subagentId: string; task: TaskSpec } | null {
  for (let i = 0; i < pendingTasks.length; i++) {
    const task = pendingTasks[i];
    if (!task) continue;
    const subagentId = task.subagentId
      ? isIdleSubagentInMap(subagents, terminating, task.subagentId)
        ? task.subagentId
        : null
      : findIdleSubagentInMap(subagents, terminating);
    if (!subagentId) continue;
    pendingTasks.splice(i, 1);
    return { subagentId, task };
  }
  return null;
}

export function createPendingAbortedResult(task: TaskSpec, message: string): TaskResult {
  return {
    subagentId: task.subagentId ?? 'unassigned',
    taskId: task.id,
    status: 'stopped',
    error: {
      kind: 'aborted_by_parent',
      message,
      retryable: false,
    },
    iterations: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}
