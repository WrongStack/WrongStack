import { randomUUID } from 'node:crypto';
import type { Context } from '@wrongstack/core/agent';
import {
  areDependenciesMet,
  assignTask,
  finalizeTaskCompletion,
  getBoard,
  type KanbanBoard,
  type KanbanEventContext,
  type KanbanTask,
  listBoards,
  reconcileKanbanBoard,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import { recordKanbanVerificationEvidence } from '@wrongstack/tools';
import type { WebSocket } from 'ws';
import type { WSServerMessage } from './types.js';
import { send } from './ws-utils.js';

export interface KanbanDispatchResult {
  status: 'completed' | 'failed';
  result?: string | undefined;
  error?: string | undefined;
}

export type KanbanTaskDispatcher = (
  description: string,
  opts?: {
    provider?: string | undefined;
    model?: string | undefined;
    fallbackModels?: string[] | undefined;
    fallbackProfile?: string | undefined;
    skills?: string[] | undefined;
    tools?: string[] | undefined;
    name?: string | undefined;
    allowedCapabilities?: readonly string[] | undefined;
    context?:
      | {
          kanban?: { boardId?: string; taskId?: string; projectRoot?: string; leaseId?: string };
        }
      | undefined;
    onDone?: ((result: KanbanDispatchResult) => void | Promise<void>) | undefined;
  },
) => Promise<string>;

export interface KanbanDispatchContext {
  projectRoot: string;
  context?: Context | undefined;
  broadcast?: ((message: WSServerMessage) => void) | undefined;
  dispatchTask?: KanbanTaskDispatcher | undefined;
}

export interface ResolvedDispatchRoute {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
}

export function parseResolvedDispatchRoute(summary: string): ResolvedDispatchRoute {
  const tags = summary.match(/Spawned subagent\s+\S+\s+\((.*?)\)\s+for task/i)?.[1];
  if (!tags) return {};
  const parts = tags.split(/\s+\/\s+/).map((part) => part.trim());
  const positional = parts.filter((part) => !part.includes('=') && !part.startsWith('"'));
  const fallbackProfile = parts.find((part) => part.startsWith('profile='))?.slice(8);
  const fallback = parts.find((part) => part.startsWith('fallback='))?.slice(9);
  return {
    ...(positional[0] ? { provider: positional[0] } : {}),
    ...(positional[1] ? { model: positional[1] } : {}),
    ...(fallbackProfile ? { fallbackProfile } : {}),
    ...(fallback ? { fallbackModels: fallback.split(',').filter(Boolean) } : {}),
  };
}

function reply(ws: WebSocket, type: string, success: boolean, value: unknown): void {
  send(ws, {
    type,
    payload: success ? { success: true, data: value } : { success: false, error: String(value) },
  });
}

function activityContext(
  ctx: KanbanDispatchContext,
  note?: string,
  expectedLeaseId?: string,
): KanbanEventContext {
  const sessionId = ctx.context?.session?.id;
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(note?.trim() ? { note: note.trim() } : {}),
    ...(expectedLeaseId ? { expectedLeaseId } : {}),
  };
}

export async function handleKanbanTaskDispatch(
  ws: WebSocket,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanDispatchContext,
): Promise<void> {
  const boardId = payload?.boardId as string | undefined;
  const taskId = payload?.taskId as string | undefined;
  if (!boardId || !taskId) {
    reply(ws, 'kanban.task.dispatch', false, 'boardId and taskId required');
    return;
  }
  if (!ctx.dispatchTask) {
    reply(
      ws,
      'kanban.task.dispatch',
      false,
      'Kanban agent dispatch is not available in this runtime',
    );
    return;
  }
  const board = await getBoard(ctx.projectRoot, boardId);
  const task = board ? findTask(board.tasks, taskId) : undefined;
  if (!board || !task) {
    reply(ws, 'kanban.task.dispatch', false, 'Board or task not found');
    return;
  }

  // Check task readiness — don't dispatch if dependencies are unmet.
  if (task.dependsOn && task.dependsOn.length > 0 && !areDependenciesMet(board, task.id)) {
    reply(ws, 'kanban.task.dispatch', false, `Task "${task.title}" has unmet dependencies and cannot be dispatched yet.`);
    return;
  }

  // Enforced atomicity: a childless leaf judged too large must be decomposed
  // before dispatch. Distinct error text so the WebUI can render a
  // "decompose" call-to-action instead of a generic failure.
  if (
    board.atomicity?.mode === 'enforce' &&
    !task.childTaskIds?.length &&
    task.atomicityAssessment?.verdict === 'needs_decomposition'
  ) {
    reply(
      ws,
      'kanban.task.dispatch',
      false,
      `Task "${task.title}" needs decomposition before dispatch (board enforces atomicity). Split it into smaller subtasks first.`,
    );
    return;
  }

  const modelRouting =
    (payload?.modelRouting as 'session' | 'fixed' | 'fallback_profile' | undefined) ??
    task.assignment?.modelRouting ??
    (payload?.provider || payload?.model || task.assignment?.provider || task.assignment?.model
      ? 'fixed'
      : 'session');
  const useSessionModel = modelRouting === 'session';
  // Generate a leaseId for fencing writes to the kanban board. This lease is
  // passed to the worker via the kanban context and expectedLeaseId in the
  // prompt instructions. Every subsequent updateTaskAssignment call fences
  // with expectedLeaseId so a recovered-and-reassigned task cannot be
  // overwritten by this worker's terminal writes.
  const leaseId = randomUUID();
  const now = new Date().toISOString();
  // Use a generous lease (30 min) so long-running workers do not silently
  // drop their completion result. The WebUI dispatch path has no host-side
  // heartbeat renewal (unlike kanban_queue's detached supervisor), so the
  // lease must outlive typical AI task durations. Workers that need more
  // time should call heartbeat_assignment with their expectedLeaseId.
  const leaseTtlMs = 30 * 60 * 1000;
  const leaseExpiresAt = new Date(Date.now() + leaseTtlMs).toISOString();
  const assignment = {
    agentId:
      (payload?.agentId as string | undefined) ?? task.assignment?.agentId ?? task.assignedAgent,
    name: (payload?.name as string | undefined) ?? task.assignment?.name ?? task.assignedAgent,
    role: (payload?.role as string | undefined) ?? task.assignment?.role,
    modelRouting,
    provider: useSessionModel
      ? ctx.context?.provider.id
      : ((payload?.provider as string | undefined) ?? task.assignment?.provider),
    model: useSessionModel
      ? ctx.context?.model
      : ((payload?.model as string | undefined) ?? task.assignment?.model),
    fallbackProfile:
      modelRouting === 'fallback_profile'
        ? ((payload?.fallbackProfile as string | undefined) ?? task.assignment?.fallbackProfile)
        : undefined,
    fallbackModels:
      (payload?.fallbackModels as string[] | undefined) ?? task.assignment?.fallbackModels,
    skills: (payload?.skills as string[] | undefined) ?? task.assignment?.skills,
    tools: (payload?.tools as string[] | undefined) ?? task.assignment?.tools,
    allowedCapabilities:
      (payload?.allowedCapabilities as string[] | undefined) ??
      task.assignment?.allowedCapabilities,
    maxAttempts: (payload?.maxAttempts as number | undefined) ?? task.assignment?.maxAttempts,
    costCeilingUsd:
      (payload?.costCeilingUsd as number | undefined) ??
      task.assignment?.costCeilingUsd ??
      task.costCeilingUsd,
    retryPolicy:
      (payload?.retryPolicy as KanbanTask['retryPolicy'] | undefined) ??
      task.assignment?.retryPolicy ??
      task.retryPolicy,
    attempt: (task.assignment?.attempt ?? 0) + 1,
    status: 'queued' as const,
    dispatchedAt: now,
    leaseId,
    claimedAt: now,
    heartbeatAt: now,
    leaseExpiresAt,
  };
  const assignedBoard = await assignTask(
    ctx.projectRoot,
    boardId,
    task.id,
    assignment,
    activityContext(ctx, payload?.activityNote as string | undefined),
  );
  if (!assignedBoard) {
    reply(ws, 'kanban.task.dispatch', false, `Failed to assign task "${task.title}". The task may have been removed or the board does not allow external assignment.`);
    return;
  }

  try {
    const summary = await ctx.dispatchTask(buildKanbanAgentPrompt(board, task, assignment, leaseId), {
      ...(assignment.provider ? { provider: assignment.provider } : {}),
      ...(assignment.model ? { model: assignment.model } : {}),
      ...(assignment.fallbackModels ? { fallbackModels: assignment.fallbackModels } : {}),
      ...(assignment.fallbackProfile ? { fallbackProfile: assignment.fallbackProfile } : {}),
      ...(assignment.skills ? { skills: assignment.skills } : {}),
      ...(assignment.tools ? { tools: assignment.tools } : {}),
      ...(assignment.name ? { name: assignment.name } : {}),
      ...(assignment.allowedCapabilities
        ? { allowedCapabilities: assignment.allowedCapabilities }
        : {}),
      context: { kanban: { boardId, taskId: task.id, projectRoot: ctx.projectRoot, leaseId } },
      onDone: async (result) => {
        const terminalWrite = await updateTaskAssignment(
          ctx.projectRoot,
          boardId,
          task.id,
          {
            ...assignment,
            status: result.status,
            ...(result.result !== undefined ? { lastResult: result.result } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          },
          activityContext(ctx, undefined, leaseId),
        );
        // Universal completion gate: updateTaskAssignment parks a completed
        // worker in review on gated boards; finalize verifies and applies the
        // final status before the board is reconciled + broadcast.
        if (result.status === 'completed' && terminalWrite) {
          try {
            const finalized = await finalizeTaskCompletion(ctx.projectRoot, boardId, task.id, {
              eventContext: activityContext(ctx, undefined, leaseId),
            });
            // Evidence bridge: link the verification report into the session's
            // completed-work ledger when this server runs inside a session.
            if (finalized?.gate.report && ctx.context) {
              recordKanbanVerificationEvidence(ctx.context, finalized.gate.report);
            }
          } catch (error) {
            console.warn(
              `[kanban-dispatch] completion gate failed for task ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const reconciled = await reconcileKanbanBoard(ctx.projectRoot, boardId);
        const completed = reconciled?.board ?? (await getBoard(ctx.projectRoot, boardId));
        const completedTask =
          completed?.tasks.find((candidate) => candidate.id === task.id) ?? task;
        ctx.broadcast?.({
          type: 'kanban.task.update',
          payload: { success: true, data: { boardId: board.id, task: completedTask } },
        });
        if (completed) {
          ctx.broadcast?.({
            type: 'kanban.get',
            payload: { success: true, data: { board: completed } },
          });
        }
        ctx.broadcast?.({
          type: 'kanban.list',
          payload: { success: true, data: await listBoards(ctx.projectRoot) },
        });
      },
    });
    const subagentId = summary.match(/Spawned subagent\s+([^\s]+)/)?.[1];
    const runTaskId = summary.match(/\bfor task\s+([^\s.]+)/i)?.[1];
    const resolvedRoute = parseResolvedDispatchRoute(summary);
    const updated = await updateTaskAssignment(
      ctx.projectRoot,
      boardId,
      task.id,
      {
        ...assignment,
        ...resolvedRoute,
        status: 'running',
        ...(subagentId ? { subagentId } : {}),
        ...(runTaskId ? { runTaskId } : {}),
        lastResult: summary,
      },
      activityContext(ctx, undefined, leaseId),
    );
    const runningTask = updated?.tasks.find((candidate) => candidate.id === task.id) ?? task;
    ctx.broadcast?.({
      type: 'kanban.task.update',
      payload: { success: true, data: { boardId: board.id, task: runningTask } },
    });
    if (updated) {
      ctx.broadcast?.({ type: 'kanban.get', payload: { success: true, data: { board: updated } } });
    }
    reply(ws, 'kanban.task.dispatch', true, { boardId: board.id, task: runningTask, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateTaskAssignment(
      ctx.projectRoot,
      boardId,
      task.id,
      { ...assignment, status: 'failed', error: message },
      activityContext(ctx, undefined, leaseId),
    );
    reply(ws, 'kanban.task.dispatch', false, message);
  }
}

function buildKanbanAgentPrompt(
  board: Pick<KanbanBoard, 'id' | 'title' | 'tasks'>,
  task: KanbanTask,
  assignment: KanbanTask['assignment'],
  leaseId: string | undefined,
): string {
  const dependencies = (task.dependsOn ?? [])
    .map((dependencyId) => board.tasks.find((candidate) => candidate.id === dependencyId))
    .filter((dependency): dependency is KanbanTask => Boolean(dependency))
    .map((dependency) => `- ${dependency.title} [${dependency.status}] (${dependency.id})`);
  const checks = task.successCriteria?.map((check) => `- ${check.description}`).join('\n');
  const metrics = task.goalMetrics
    ?.map(
      (metric) =>
        `- ${metric.name}: ${metric.current ?? 'n/a'}${metric.target !== undefined ? ` / ${metric.target}` : ''}${metric.unit ? ` ${metric.unit}` : ''} [${metric.status}]`,
    )
    .join('\n');
  const chain = task.chain
    ? [
        `chainId: ${task.chain.chainId}`,
        `order: ${task.chain.order}`,
        task.chain.previousTaskId ? `previous: ${task.chain.previousTaskId}` : '',
        task.chain.nextTaskId ? `next: ${task.chain.nextTaskId}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const routing = [
    assignment?.role ? `role: ${assignment.role}` : '',
    assignment?.modelRouting ? `modelRouting: ${assignment.modelRouting}` : '',
    assignment?.provider ? `provider: ${assignment.provider}` : '',
    assignment?.model ? `model: ${assignment.model}` : '',
    assignment?.fallbackProfile ? `fallbackProfile: ${assignment.fallbackProfile}` : '',
    assignment?.fallbackModels?.length
      ? `fallbackModels: ${assignment.fallbackModels.join(', ')}`
      : '',
    assignment?.skills?.length ? `skills: ${assignment.skills.join(', ')}` : '',
  ].filter(Boolean);
  return [
    'You are processing a WrongStack kanban task.',
    '',
    `Board: ${board.title} (${board.id})`,
    `Task: ${task.title} (${task.id})`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    task.description ? `Description:\n${task.description}` : '',
    routing.length ? `Routing hints:\n${routing.join('\n')}` : '',
    chain ? `Task chain:\n${chain}` : '',
    dependencies.length ? `Dependencies:\n${dependencies.join('\n')}` : '',
    checks ? `Success criteria:\n${checks}` : '',
    metrics ? `Goal metrics:\n${metrics}` : '',
    task.labels?.length ? `Labels: ${task.labels.join(', ')}` : '',
    '',
    'Work the task end-to-end. Use the kanban tool, not direct file edits, to update this task.',
    ...(leaseId ? [
      'LEASE CONTRACT:',
      `- Your leaseId is "${leaseId}". Include expectedLeaseId "${leaseId}" in every mark_assignment and heartbeat_assignment call.`,
      '- The expectedLeaseId fence makes your write a safe no-op if recover_stale already reassigned the task because your lease expired (e.g. if you take too long).',
      '- If your lease expires, call heartbeat_assignment with expectedLeaseId to extend it, or release_task so another worker can claim.',
      'On failure the host may call recover_stale; respect its decisions and do not duplicate work.',
    ] : []),
    `When you start or finish, call kanban with action "mark_assignment", boardId "${board.id}", taskId "${task.id}", and assignmentStatus "running", "completed", or "failed"${leaseId ? `, and expectedLeaseId "${leaseId}"` : ''}. Include lastResult or error when you finish.`,
    'When finished, report what changed, what you verified, and any remaining blockers.',
  ]
    .filter(Boolean)
    .join('\n');
}

function findTask(tasks: KanbanTask[], taskId: string): KanbanTask | undefined {
  return tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
}
