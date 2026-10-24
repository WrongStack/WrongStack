import type { TaskNode, TaskResult } from '@wrongstack/contracts/types';
import type { SddSupervisorVerdict, TaskOutcome, WaveResult } from './sdd-parallel-run-types.js';
import type { TaskBatch } from './sdd-task-decomposer.js';
import { executeSddTask } from './sdd-task-execution.js';

export interface SddTaskDispatchHost {
  executeOne: (
    task: import('@wrongstack/contracts/types').TaskNode,
  ) => Promise<import('./sdd-parallel-run-types.js').TaskOutcome>;
  stopRequested: boolean;
  opts: import('./sdd-parallel-run-types.js').SddParallelRunOptions;
  coordinator: import('@wrongstack/core/coordination').DefaultMultiAgentCoordinator | null;
  usedNicknames: Set<string>;
  idleTimeoutMs: number;
  timeoutMs: number | undefined;
  runId: string;
  dispatchSeq: number;
  emit: <K extends keyof import('@wrongstack/contracts/kernel').EventMap>(
    event: K,
    payload: import('@wrongstack/contracts/kernel').EventMap[K],
  ) => void;
  taskCwds: Map<string, string>;
  taskBranches: Map<string, string>;
  taskSubagents: Map<string, string>;
  cancelledTasks: Set<string>;
  allocateWorktrees: (tasks: import('@wrongstack/contracts/types').TaskNode[]) => Promise<void>;
  resolveWorktrees: (tasks: import('@wrongstack/contracts/types').TaskNode[]) => Promise<void>;
  integrateWorktree: (
    task: import('@wrongstack/contracts/types').TaskNode,
    result?: import('@wrongstack/contracts/types').TaskResult<unknown> | undefined,
  ) => Promise<{ ok: boolean; conflictFiles?: string[]; reason?: string; fatal?: boolean }>;
  applyTaskFailure: (taskId: string, subagentId: string, errMsg: string) => Promise<void>;
  retryMap: Map<string, number>;
  persistRetries: (taskId: string, retries: number) => void;
  maxRetries: number;
  trySupervisorRescue: (taskId: string, errMsg: string) => Promise<boolean>;
  supervisorEscalations: Map<string, number>;
  maxSupervisorEscalations: number;
  setTaskModel: (
    taskId: string,
    model: string | undefined,
    provider?: string | undefined,
  ) => boolean;
  splitTask: (
    taskId: string,
    subtasks: import('./sdd-parallel-run-types.js').SddSubtaskSpec[],
  ) => string[];
}

export async function executeWave(
  this: SddTaskDispatchHost,
  batch: TaskBatch,
): Promise<WaveResult> {
  const waveStart = Date.now();
  const outcomes = await Promise.all(batch.tasks.map((task) => this.executeOne(task)));
  const results = outcomes.map((o) => o.result).filter((r): r is TaskResult => Boolean(r));
  const successCount = outcomes.filter((o) => o.success).length;
  const failCount = outcomes.length - successCount;
  return {
    wave: batch.wave,
    batch,
    results,
    successCount,
    failCount,
    durationMs: Date.now() - waveStart,
    stopRequested: this.stopRequested,
  };
}

export async function executeOne(this: SddTaskDispatchHost, task: TaskNode): Promise<TaskOutcome> {
  const outcome = await executeSddTask({
    task,
    opts: this.opts,
    coordinator: this.coordinator,
    usedNicknames: this.usedNicknames,
    idleTimeoutMs: this.idleTimeoutMs,
    timeoutMs: this.timeoutMs,
    runId: this.runId,
    nextSubagentId: () => `sdd-d${this.dispatchSeq++}`,
    emit: (event, payload) => this.emit(event, payload),
    taskCwds: this.taskCwds,
    taskBranches: this.taskBranches,
    taskSubagents: this.taskSubagents,
    cancelledTasks: this.cancelledTasks,
    allocateWorktrees: (tasks) => this.allocateWorktrees(tasks),
    resolveWorktrees: (tasks) => this.resolveWorktrees(tasks),
    integrateWorktree: (taskNode, result) => this.integrateWorktree(taskNode, result),
    applyTaskFailure: (taskId, subagentId, errMsg) =>
      this.applyTaskFailure(taskId, subagentId, errMsg),
  });
  if (outcome.success) {
    this.retryMap.delete(task.id);
    this.persistRetries(task.id, 0);
  }
  return outcome;
}

export async function applyTaskFailure(
  this: SddTaskDispatchHost,
  taskId: string,
  subagentId: string,
  errMsg: string,
): Promise<void> {
  const currentRetries = this.retryMap.get(taskId) ?? 0;
  if (currentRetries < this.maxRetries) {
    this.retryMap.set(taskId, currentRetries + 1);
    this.persistRetries(taskId, currentRetries + 1);
    this.opts.tracker.updateNodeStatus(
      taskId,
      'pending',
      `Retry ${currentRetries + 1}/${this.maxRetries}: ${errMsg}`,
    );
    this.emit('sdd.task.retrying', {
      runId: this.runId,
      taskId,
      attempt: currentRetries + 1,
      maxRetries: this.maxRetries,
    });
    return;
  }

  // Retries exhausted — give the supervisor a bounded chance to rescue the
  // task before it goes terminal, so a run "decides" rather than dead-ends.
  if (await this.trySupervisorRescue(taskId, errMsg)) return;

  this.opts.tracker.updateNodeStatus(taskId, 'failed', errMsg);
  this.emit('sdd.task.failed', { runId: this.runId, taskId, subagentId, error: errMsg });
}

export async function trySupervisorRescue(
  this: SddTaskDispatchHost,
  taskId: string,
  errMsg: string,
): Promise<boolean> {
  const supervise = this.opts.superviseFailure;
  if (!supervise) return false;
  const used = this.supervisorEscalations.get(taskId) ?? 0;
  if (used >= this.maxSupervisorEscalations) return false;
  const node = this.opts.tracker.getNode(taskId);
  if (!node) return false;

  let verdict: SddSupervisorVerdict | undefined;
  try {
    verdict = await supervise({ task: node, error: errMsg, attempts: used });
  } catch {
    return false; // a flaky supervisor must not block terminal failure
  }
  if (!verdict || verdict.action === 'fail') return false;

  this.supervisorEscalations.set(taskId, used + 1);
  const requeue = (reason: string) => {
    this.retryMap.delete(taskId);
    this.persistRetries(taskId, 0);
    this.opts.tracker.updateNodeStatus(taskId, 'pending', reason);
  };

  if (verdict.action === 'reassign') {
    this.setTaskModel(taskId, verdict.model, verdict.provider);
    requeue(`supervisor reassign: ${verdict.model ?? 'default'}`);
    this.emit('sdd.supervisor.decision', { runId: this.runId, taskId, action: 'reassign' });
    return true;
  }
  if (verdict.action === 'split') {
    // The failed attempt is over (its subagent is released) but the node still
    // reads `in_progress`, which splitGraphNode refuses as "running" — so a
    // split verdict never applied on the real path. Settle it to `pending`
    // (no cascade) first; a refused split is overwritten by the terminal fail.
    if (this.opts.tracker.getNode(taskId)?.status === 'in_progress') {
      this.opts.tracker.updateNodeStatus(taskId, 'pending', 'supervisor split');
    }
    const ids = this.splitTask(taskId, verdict.subtasks);
    if (ids.length === 0) return false; // split refused (e.g. running) → let it fail
    this.emit('sdd.supervisor.decision', { runId: this.runId, taskId, action: 'split' });
    return true;
  }
  // 'retry'
  requeue('supervisor retry');
  this.emit('sdd.supervisor.decision', { runId: this.runId, taskId, action: 'retry' });
  return true;
}
