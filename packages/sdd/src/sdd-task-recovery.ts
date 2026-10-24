import type { TaskTracker } from '@wrongstack/core/tasking';

import type { SddParallelRunOptions } from './sdd-parallel-run-types.js';

export interface SddTaskRecoveryHost {
  opts: SddParallelRunOptions;
  retryMap: Map<string, number>;
  persistRetries: (taskId: string, retries: number) => void;
  cancelledTasks: Set<string>;
  emit: <K extends keyof import('@wrongstack/contracts/kernel').EventMap>(
    event: K,
    payload: import('@wrongstack/contracts/kernel').EventMap[K],
  ) => void;
  runId: string;
  maxRetries: number;
}
export function computeDeadlockChains(
  host: SddTaskRecoveryHost,
): Array<{ blocked: string; blockedBy: string[] }> {
  const tracker = host.opts.tracker;
  const chains: Array<{ blocked: string; blockedBy: string[] }> = [];
  for (const node of tracker.getAllNodes()) {
    if (node.status === 'completed' || node.status === 'failed') continue;
    const blockedBy = tracker
      .getBlockers(node.id)
      .filter((id) => tracker.getNode(id)?.status !== 'completed');
    if (blockedBy.length > 0) chains.push({ blocked: node.id, blockedBy });
  }
  return chains;
}

export function recoverFailedBlockers(host: SddTaskRecoveryHost): boolean {
  const tracker = host.opts.tracker;
  let recovered = false;
  for (const node of tracker.getAllNodes({ status: ['failed'] })) {
    // Honour the cancel marker, exactly as `requeueFailedTasks` does below.
    // `cancelTask` sets BOTH markers and documents that they "block
    // retry/auto-redispatch"; without this check the deadlock round resurrected
    // a user-cancelled blocker to 'pending', re-dispatching work the user
    // explicitly stopped and clearing the board's "Cancelled" state.
    if (host.cancelledTasks.has(node.id) || node.metadata?.cancelled) continue;
    const blocksIncomplete = tracker.getDependents(node.id).some((d) => {
      const s = tracker.getNode(d)?.status;
      return s !== 'completed' && s !== 'failed';
    });
    if (blocksIncomplete) {
      host.retryMap.delete(node.id);
      host.persistRetries(node.id, 0);
      tracker.updateNodeStatus(node.id, 'pending', 'deadlock recovery');
      recovered = true;
    }
  }
  return recovered;
}

export function requeueFailedTasks(
  host: SddTaskRecoveryHost,
  reason = 'retry failed sweep',
): number {
  const tracker = host.opts.tracker;
  let n = 0;
  for (const node of tracker.getAllNodes({ status: ['failed'] })) {
    if (host.cancelledTasks.has(node.id) || node.metadata?.cancelled) continue;
    host.retryMap.delete(node.id);
    host.persistRetries(node.id, 0);
    tracker.updateNodeStatus(node.id, 'pending', reason);
    host.emit('sdd.task.retrying', {
      runId: host.runId,
      taskId: node.id,
      attempt: 0,
      maxRetries: host.maxRetries,
    });
    n++;
  }
  return n;
}

export function restoreRetryMap(host: SddTaskRecoveryHost): void {
  host.retryMap.clear();
  for (const node of host.opts.tracker.getAllNodes()) {
    const r = (node.metadata as { retries?: unknown } | undefined)?.retries;
    if (typeof r === 'number' && r > 0) host.retryMap.set(node.id, r);
  }
}

export function resetOrphans(tracker: TaskTracker): number {
  let n = 0;
  for (const node of tracker.getAllNodes({ status: ['in_progress'] })) {
    tracker.updateNodeStatus(node.id, 'pending', 'resume: orphaned in_progress');
    n++;
  }
  return n;
}
