import { sealedSubagentRefusal } from '../core/sealed-agent.js';
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
    // A sealed companion is idle between its host's probes; it is never
    // a free worker for someone else's unpinned task.
    if (s.status === 'idle' && !terminating.has(id) && !s.config.sealed) return id;
  }
  return null;
}

/** Throws when a task would reach a sealed subagent without its host's admission. */
export function assertSealedAdmission(
  subagents: Map<string, SubagentEntry>,
  subagentId: string | undefined,
  hostOwned: boolean | undefined,
): void {
  if (!subagentId || hostOwned) return;
  if (subagents.get(subagentId)?.config.sealed) throw new Error(sealedSubagentRefusal(subagentId));
}

/** A pending task may be moved only when neither its current nor its new pin is sealed. */
export function canRetargetAroundSealed(
  subagents: Map<string, SubagentEntry>,
  from: string | undefined,
  to: string | undefined,
): boolean {
  return !(from && subagents.get(from)?.config.sealed) && !(to && subagents.get(to)?.config.sealed);
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
