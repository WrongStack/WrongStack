import { describeKanbanBoundary, type KanbanBoard, type KanbanTask } from '@wrongstack/kanban';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import { normalizeWorktreeOverride, stringArray } from './director-input-helpers.js';

export interface KanbanQueueInput {
  action?: 'dispatch_ready' | undefined;
  boardId?: string | undefined;
  taskId?: string | undefined;
  query?: string | undefined;
  maxTasks?: number | undefined;
  awaitCompletion?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxToolCalls?: number | undefined;
  agentId?: string | undefined;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackModels?: string[] | undefined;
  tools?: string[] | undefined;
  allowedCapabilities?: string[] | undefined;
  worktree?: SubagentConfig['worktree'] | undefined;
  heartbeatIntervalMs?: number | undefined;
  leaseTtlMs?: number | undefined;
}

export function normalizeKanbanQueueInput(input: unknown): KanbanQueueInput {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    action: raw.action === 'dispatch_ready' ? 'dispatch_ready' : undefined,
    boardId: typeof raw.boardId === 'string' ? raw.boardId : undefined,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
    query: typeof raw.query === 'string' ? raw.query : undefined,
    maxTasks: typeof raw.maxTasks === 'number' ? raw.maxTasks : undefined,
    awaitCompletion: typeof raw.awaitCompletion === 'boolean' ? raw.awaitCompletion : undefined,
    timeoutMs: typeof raw.timeoutMs === 'number' ? raw.timeoutMs : undefined,
    maxToolCalls: typeof raw.maxToolCalls === 'number' ? raw.maxToolCalls : undefined,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : undefined,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    role: typeof raw.role === 'string' ? raw.role : undefined,
    provider: typeof raw.provider === 'string' ? raw.provider : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    fallbackModels: stringArray(raw.fallbackModels),
    tools: stringArray(raw.tools),
    allowedCapabilities: stringArray(raw.allowedCapabilities),
    worktree: normalizeWorktreeOverride(raw.worktree),
    heartbeatIntervalMs:
      typeof raw.heartbeatIntervalMs === 'number' ? raw.heartbeatIntervalMs : undefined,
    leaseTtlMs: typeof raw.leaseTtlMs === 'number' ? raw.leaseTtlMs : undefined,
  };
}

export function buildKanbanSubagentConfig(
  task: KanbanTask,
  input: KanbanQueueInput,
  roster: Record<string, SubagentConfig> | undefined,
  instantiateRosterConfig: (role: string, base: SubagentConfig) => SubagentConfig,
): SubagentConfig {
  const assignment = task.assignment;
  const role = input.role ?? assignment?.role;
  const base =
    role && roster?.[role] ? instantiateRosterConfig(role, roster[role] ?? {}) : undefined;
  const tools = input.tools ?? assignment?.tools ?? base?.tools;
  const name =
    input.name ??
    assignment?.name ??
    input.agentId ??
    assignment?.agentId ??
    task.assignedAgent ??
    role ??
    'kanban-agent';
  return {
    ...(base ?? { name }),
    name: base?.name ?? name,
    ...(role !== undefined ? { role } : {}),
    ...((input.provider ?? assignment?.provider)
      ? { provider: input.provider ?? assignment?.provider }
      : {}),
    ...((input.model ?? assignment?.model) ? { model: input.model ?? assignment?.model } : {}),
    ...((input.fallbackModels ?? assignment?.fallbackModels)
      ? { fallbackModels: input.fallbackModels ?? assignment?.fallbackModels }
      : {}),
    ...(tools ? { tools: ensureKanbanTool(tools) } : {}),
    ...((input.allowedCapabilities ?? assignment?.allowedCapabilities)
      ? { allowedCapabilities: input.allowedCapabilities ?? assignment?.allowedCapabilities }
      : {}),
    ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
    ...(assignment?.costCeilingUsd !== undefined ? { maxCostUsd: assignment.costCeilingUsd } : {}),
  };
}

export function matchesKanbanQueueQuery(task: KanbanTask, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    task.title,
    task.description,
    task.assignedAgent,
    task.assignee,
    task.origin?.system,
    task.origin?.graphId,
    task.origin?.phaseId,
    ...(task.labels ?? []),
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalized));
}

export function buildKanbanFleetTaskPrompt(
  board: KanbanBoard,
  task: KanbanTask,
  lease: {
    heartbeatIntervalMs: number;
    leaseTtlMs: number;
    leaseId: string;
    leaseExpiresAt: string;
  },
): string {
  const dependencyLines = (task.dependsOn ?? [])
    .map((depId) => board.tasks.find((candidate) => candidate.id === depId))
    .filter((dep): dep is KanbanTask => Boolean(dep))
    .map((dep) => `- ${dep.title} [${dep.status}] (${dep.id})`);
  const checks = task.successCriteria?.map((check) => `- ${check.description}`).join('\n');
  const metrics = task.goalMetrics
    ?.map(
      (metric) =>
        `- ${metric.name}: ${metric.current ?? 'n/a'}${metric.target !== undefined ? ` / ${metric.direction === 'at_most' ? '≤' : '≥'} ${metric.target}` : ''}${metric.unit ? ` ${metric.unit}` : ''} [${metric.status}]`,
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
    task.assignment?.role ? `role: ${task.assignment.role}` : '',
    task.assignment?.provider ? `provider: ${task.assignment.provider}` : '',
    task.assignment?.model ? `model: ${task.assignment.model}` : '',
    task.assignment?.fallbackProfile ? `fallbackProfile: ${task.assignment.fallbackProfile}` : '',
    task.assignment?.fallbackModels?.length
      ? `fallbackModels: ${task.assignment.fallbackModels.join(', ')}`
      : '',
  ].filter(Boolean);
  const origin = task.origin
    ? [
        `system: ${task.origin.system}`,
        task.origin.graphId ? `graphId: ${task.origin.graphId}` : '',
        task.origin.phaseId ? `phaseId: ${task.origin.phaseId}` : '',
        task.origin.taskId ? `sourceTaskId: ${task.origin.taskId}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';
  const boundaries = [
    board.boundary?.enabled ? `board: ${describeKanbanBoundary(board.boundary)}` : '',
    task.boundary?.enabled ? `task: ${describeKanbanBoundary(task.boundary)}` : '',
    ...(board.boundary?.allow ?? []).map(
      (selector) => `board allow ${selector.access} ${selector.kind}:${selector.path}`,
    ),
    ...(task.boundary?.allow ?? []).map(
      (selector) => `task allow ${selector.access} ${selector.kind}:${selector.path}`,
    ),
  ].filter(Boolean);
  return [
    'You are processing a claimed WrongStack Kanban task.',
    '',
    `Board: ${board.title} (${board.id})`,
    `Task: ${task.title} (${task.id})`,
    `Status: ${task.status}`,
    `Priority: ${task.priority}`,
    task.description ? `Description:\n${task.description}` : '',
    origin ? `Origin:\n${origin}` : '',
    routing.length ? `Routing hints:\n${routing.join('\n')}` : '',
    chain ? `Task chain:\n${chain}` : '',
    dependencyLines.length ? `Dependencies:\n${dependencyLines.join('\n')}` : '',
    checks ? `Success criteria:\n${checks}` : '',
    metrics ? `Goal metrics:\n${metrics}` : '',
    task.labels?.length ? `Labels: ${task.labels.join(', ')}` : '',
    boundaries.length
      ? `BOUNDARY CONTRACT (enforced by the tool runtime; do not attempt to bypass):\n${boundaries.map((line) => `- ${line}`).join('\n')}`
      : '',
    'Lease contract (Sprint 1):',
    `- leaseId: ${lease.leaseId}`,
    `- claimedAt: ${task.assignment?.claimedAt ?? '<unknown>'}`,
    `- leaseExpiresAt: ${lease.leaseExpiresAt}`,
    `- expected heartbeatIntervalMs: ${lease.heartbeatIntervalMs}`,
    `- expected leaseTtlMs: ${lease.leaseTtlMs}`,
    '',
    'Retry policy:',
    `- retryPolicy: ${task.assignment?.retryPolicy ?? task.retryPolicy ?? '<unset>'}`,
    `- maxAttempts: ${task.assignment?.maxAttempts ?? '<unset>'}`,
    `- costCeilingUsd: ${task.assignment?.costCeilingUsd ?? task.costCeilingUsd ?? '<unset>'}`,
    '',
    'Work this task end-to-end. Treat the board as a live plan, not a frozen assignment snapshot.',
    `Before material work and whenever evidence changes the plan, call kanban with action "get_board" and boardId "${board.id}" to reassess current tasks, dependencies, priorities, and peer changes.`,
    'You may use kanban add_task, update_task, split_task, merge_tasks, move_task, delete_task, or dependency actions when reassessment shows the plan should change. Preserve traceability and do not keep obsolete work merely because it existed at dispatch time.',
    '',
    'FIELD MAINTENANCE — keep every task detail current:',
    '- Call "update_task" to refresh description, priority, type, labels, or estimatedHours as the work evolves.',
    '- Call "add_note" with author and content to record progress, decisions, or roadblock context.',
    '- Call "add_check" / "update_check" with description and status (pending/passed/failed) to track acceptance criteria.',
    '- Call "add_goal_metric" / "update_goal_metric" with name and current/target to report measurable progress.',
    '- Call "add_link" with url and type (issue/pr/doc/commit/design/file/url/other) to attach evidence.',
    '- Call "update_task" to set actualHours when you have a final time estimate.',
    'Do not leave stale or placeholder field values — the kanban board is the shared source of truth for every stakeholder.',
    '',
    'LEASE & LIFECYCLE:',
    'Every successful board mutation updates shared pending work and notifies the owning session. Re-read the board after mutations and adapt to changes made by other agents; never assume your initial todo list remains authoritative.',
    `When you start, call kanban with action "mark_assignment", boardId "${board.id}", taskId "${task.id}", assignmentStatus "running", and expectedLeaseId "${lease.leaseId}". Include subagentId and runTaskId when you have them. The expectedLeaseId fence makes the write a safe no-op if recover_stale already reassigned the task because your lease expired.`,
    `To stay alive in the queue, call kanban with action "heartbeat_assignment", boardId "${board.id}", taskId "${task.id}", heartbeatAt set to the current time, and expectedLeaseId "${lease.leaseId}". Cadence must be <= heartbeatIntervalMs and well before leaseExpiresAt. The expectedLeaseId fence makes the heartbeat a safe no-op if the lease was reassigned, so a stale worker cannot renew a successor's lease.`,
    `When you finish, call kanban with action "mark_assignment", boardId "${board.id}", taskId "${task.id}", assignmentStatus "completed" or "failed", and expectedLeaseId "${lease.leaseId}". Include lastResult or error. Populate every relevant detail field before the terminal mark_assignment so the card's final state is complete. On managed lifecycle boards, mark_assignment(completed) will automatically advance your card from Running to Review — a separate verification step is required before the card reaches Done.`,
    `If you cannot finish in time, call kanban with action "heartbeat_assignment" to extend the lease, or with action "release_task" to release so another worker can claim. Do NOT silently abandon the assignment.`,
    'On failure the host may call kanban with action "recover_stale" (mode: retry/release/fail); respect its decisions and do not duplicate work in parallel.',
    'When finished, report what changed, what you verified, and any remaining blockers.',
  ]
    .filter(Boolean)
    .join('\n');
}

export function resultToText(result: TaskResult): string {
  if (typeof result.result === 'string') return result.result;
  if (result.result === undefined) return '';
  try {
    return JSON.stringify(result.result);
  } catch {
    return String(result.result);
  }
}

export function resultErrorText(result: TaskResult): string {
  return result.error ? `${result.error.kind}: ${result.error.message}` : result.status;
}

function ensureKanbanTool(tools: readonly string[]): string[] {
  return tools.includes('kanban') ? [...tools] : [...tools, 'kanban'];
}
