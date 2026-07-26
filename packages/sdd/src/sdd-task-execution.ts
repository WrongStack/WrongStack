import { randomUUID } from 'node:crypto';
import { expectDefined } from '@wrongstack/core/utils';
import { assignNickname, type DefaultMultiAgentCoordinator } from '@wrongstack/core/coordination';
import type { EventMap } from '@wrongstack/core/kernel';
import type { TaskNode, TaskResult } from '@wrongstack/core/types';
import { ERROR_CODES, SddError } from '@wrongstack/core/types';
import type { SddParallelRunOptions, TaskOutcome } from './sdd-parallel-run-types.js';

export async function executeSddTask(params: {
  task: TaskNode;
  opts: SddParallelRunOptions;
  coordinator: DefaultMultiAgentCoordinator | null;
  usedNicknames: Set<string>;
  idleTimeoutMs: number;
  timeoutMs: number | undefined;
  runId: string;
  nextSubagentId: () => string;
  emit: <K extends keyof EventMap>(event: K, payload: EventMap[K]) => void;
  taskCwds: ReadonlyMap<string, string>;
  taskBranches: ReadonlyMap<string, string>;
  taskSubagents: Map<string, string>;
  cancelledTasks: ReadonlySet<string>;
  allocateWorktrees: (tasks: TaskNode[]) => Promise<void>;
  resolveWorktrees: (tasks: TaskNode[]) => Promise<void>;
  integrateWorktree: (
    task: TaskNode,
    result?: TaskResult,
  ) => Promise<{ ok: boolean; conflictFiles?: string[]; reason?: string }>;
  applyTaskFailure: (taskId: string, subagentId: string, errMsg: string) => Promise<void>;
}): Promise<TaskOutcome> {
  const { task, opts } = params;
  const taskId = task.id;
  let agentName = task.assignee;
  if (!agentName) {
    const nick = assignNickname('executor', params.usedNicknames);
    params.usedNicknames.add(nick.key);
    agentName = nick.display.replace(/\s*\([^)]*\)\s*$/, '');
    opts.tracker.updateNode(taskId, { assignee: agentName });
  }

  opts.tracker.updateNodeStatus(taskId, 'in_progress');
  await params.allocateWorktrees([task]);

  if (!params.coordinator)
    throw new SddError({
      message: 'SDD parallel runner requires a coordinator',
      code: ERROR_CODES.SDD_INVALID_STATE,
    });
  const coordinator = params.coordinator;

  const subagentId = params.nextSubagentId();
  const correlationId = randomUUID();
  const meta = (task.metadata ?? {}) as Record<string, unknown>;
  const model = (typeof meta.model === 'string' ? meta.model : undefined) ?? opts.defaultModel;
  const provider =
    (typeof meta.provider === 'string' ? meta.provider : undefined) ?? opts.defaultProvider;
  const fallbackModels = Array.isArray(meta.fallbackModels)
    ? (meta.fallbackModels as string[])
    : opts.fallbackModels;

  const spawnResult = await coordinator.spawn({
    id: subagentId,
    name: agentName,
    role: 'executor',
    idleTimeoutMs: params.idleTimeoutMs,
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    cwd: params.taskCwds.get(taskId),
    disabledTools: ['delegate'],
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
    ...(fallbackModels?.length ? { fallbackModels } : {}),
  });
  if (!spawnResult.subagentId) {
    throw new SddError({
      message: 'One or more subagent spawns failed',
      code: ERROR_CODES.SDD_INVALID_STATE,
    });
  }

  params.taskSubagents.set(taskId, subagentId);
  params.emit('sdd.task.started', {
    runId: params.runId,
    taskId,
    subagentId,
    agentName,
    worktreeBranch: params.taskBranches.get(taskId),
  });

  await coordinator.assign({
    id: correlationId,
    description: buildTaskDirective(opts.graph.title, task),
    subagentId,
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
    context: {
      telemetryTaskId: taskId,
      telemetryRunId: params.runId,
      telemetryBoardId: opts.graph.id,
    },
  });

  let result: TaskResult;
  try {
    const got = await coordinator.awaitTasks([correlationId]);
    result = expectDefined(got[0]);
  } catch (err) {
    result = {
      subagentId,
      taskId: correlationId,
      status: 'failed',
      error: { kind: 'unknown', message: String(err), retryable: false },
      iterations: 0,
      toolCalls: 0,
      durationMs: 0,
    };
  }

  params.taskSubagents.delete(taskId);

  if (params.cancelledTasks.has(taskId)) {
    await params.resolveWorktrees([task]);
    return { taskId, success: false, result };
  }

  const verificationFailReason = await verifyTaskResult(params, result);
  let success = false;
  if (result.status === 'success' && !verificationFailReason) {
    const merged = await params.integrateWorktree(task, result);
    if (merged.ok) {
      success = true;
      opts.tracker.updateNodeStatus(taskId, 'completed');
      params.emit('sdd.task.completed', {
        runId: params.runId,
        taskId,
        subagentId,
        durationMs: result.durationMs,
      });
    } else if (merged.reason) {
      params.emit('sdd.task.verification_failed', {
        runId: params.runId,
        taskId,
        reason: merged.reason,
      });
      await params.applyTaskFailure(taskId, subagentId, merged.reason);
    } else {
      const conflictFiles = merged.conflictFiles ?? [];
      params.emit('sdd.task.conflict', { runId: params.runId, taskId, conflictFiles });
      const reason = `merge conflict${conflictFiles.length ? `: ${conflictFiles.join(', ')}` : ''}`;
      await params.applyTaskFailure(taskId, subagentId, reason);
    }
  } else {
    const errMsg =
      verificationFailReason ??
      (result.error?.kind
        ? `${result.error.kind}: ${result.error.message}`
        : (result.error?.message ?? 'unknown error'));
    await params.applyTaskFailure(taskId, subagentId, errMsg);
    await params.resolveWorktrees([task]);
  }

  return { taskId, success, result };
}

function buildTaskDirective(graphTitle: string, task: TaskNode): string {
  const directivePreamble = [
    '═══ SDD PARALLEL EXECUTION ═══',
    '',
    `Graph: ${graphTitle}`,
    '',
    '── EXECUTION PROTOCOL ──',
    '• Execute the assigned SDD task end-to-end using multiple tool calls.',
    '• Mark the task [done] in the tracker when complete.',
    '• Do not ask before routine in-project tool use; if a permission gate appears, wait for that flow.',
    '• Keep output concise — summarize changes, do not transcribe files.',
  ].join('\n');

  return [
    directivePreamble,
    '',
    `── TASK ──`,
    `[${task.priority.toUpperCase()}] ${task.title}`,
    '',
    task.description,
  ].join('\n');
}

async function verifyTaskResult(
  params: Parameters<typeof executeSddTask>[0],
  result: TaskResult,
): Promise<string | undefined> {
  const { task, opts, taskCwds } = params;
  if (result.status !== 'success' || !opts.verifyTask) return undefined;

  const taskId = task.id;
  const cwd = taskCwds.get(taskId) ?? opts.projectRoot;
  let verificationFailReason: string | undefined;
  try {
    const verdict = await opts.verifyTask({ task, result, cwd });
    if (!verdict.ok) {
      verificationFailReason = `verification failed: ${verdict.reason ?? 'acceptance criteria not met'}`;
    }
  } catch (err) {
    verificationFailReason = `verification error: ${String(err)}`;
  }

  const hadVerifiable =
    typeof task.metadata?.['verificationCommand'] === 'string' ||
    task.description.includes('**Acceptance Criteria:**');
  if (verificationFailReason) {
    opts.tracker.patchMetadata(taskId, {
      verificationState: 'failed',
      verificationDetail: verificationFailReason,
    });
    params.emit('sdd.task.verification_failed', {
      runId: params.runId,
      taskId,
      reason: verificationFailReason,
    });
  } else if (hadVerifiable) {
    opts.tracker.patchMetadata(taskId, {
      verificationState: 'passed',
      verificationDetail: undefined,
    });
  }
  return verificationFailReason;
}
