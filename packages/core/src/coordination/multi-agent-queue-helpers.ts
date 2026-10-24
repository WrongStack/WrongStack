import type {
  SubagentConfig,
  SubagentContext,
  TaskResult,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import { sealedSubagentRefusal } from '../core/sealed-agent.js';
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

/**
 * A pending task may be moved only when neither its current nor its new pin is
 * sealed, and never onto a stopped subagent (it would wait there forever).
 */
export function canRetargetAroundSealed(
  subagents: Map<string, SubagentEntry>,
  from: string | undefined,
  to: string | undefined,
): boolean {
  return (
    !(from && subagents.get(from)?.config.sealed) &&
    !(to && subagents.get(to)?.config.sealed) &&
    !isStoppedPin(subagents, to)
  );
}

/** Only an idle pin is ever dispatched: a task pinned to a stopped subagent would wait forever. */
export function isStoppedPin(
  subagents: Map<string, SubagentEntry>,
  subagentId: string | undefined,
): boolean {
  return subagentId !== undefined && subagents.get(subagentId)?.status === 'stopped';
}

/** Remove and return, in queue order, the pending tasks pinned to `subagentId`. */
export function takePendingPinnedTo(pendingTasks: TaskSpec[], subagentId: string): TaskSpec[] {
  const taken: TaskSpec[] = [];
  for (let i = 0; i < pendingTasks.length; ) {
    if (pendingTasks[i]?.subagentId === subagentId) taken.push(...pendingTasks.splice(i, 1));
    else i++;
  }
  return taken;
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
  pendingTasks?: readonly TaskSpec[],
): boolean {
  if (pendingTasks && pendingTasks.length > 0) {
    for (const task of pendingTasks) {
      if (task.subagentId) {
        const pinned = subagents.get(task.subagentId);
        if (pinned && pinned.status !== 'stopped' && !terminating.has(task.subagentId)) {
          return true;
        }
      }
    }
  }
  let nonSealedCount = 0;
  for (const [id, s] of subagents) {
    if (s.config.sealed) continue;
    nonSealedCount += 1;
    if (s.status !== 'stopped' && !terminating.has(id)) return true;
  }
  return nonSealedCount === 0;
}

export function takeNextDispatchableTaskFromQueue(
  pendingTasks: TaskSpec[],
  subagents: Map<string, SubagentEntry>,
  terminating: Set<string>,
  allowUnsealed = true,
): { subagentId: string; task: TaskSpec } | null {
  for (let i = 0; i < pendingTasks.length; i++) {
    const task = pendingTasks[i];
    if (!task) continue;
    const isSealedPin = Boolean(task.subagentId && subagents.get(task.subagentId)?.config.sealed);
    if (!isSealedPin && !allowUnsealed) continue;
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
