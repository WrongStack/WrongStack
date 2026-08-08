import type { KanbanBoard, KanbanTask, KanbanTaskStatus } from '@wrongstack/kanban';

export type KanbanAuditSeverity = 'error' | 'warning';

export type KanbanAuditIssueCode =
  | 'missing-description'
  | 'missing-assignee'
  | 'missing-due-date'
  | 'missing-labels'
  | 'missing-subtasks'
  | 'missing-success-criteria'
  | 'skipped-lifecycle-state'
  | 'abandoned-running-task'
  | 'stale-running-task'
  | 'stale-review';

export interface KanbanAuditIssue {
  id: string;
  taskId: string;
  taskTitle: string;
  code: KanbanAuditIssueCode;
  severity: KanbanAuditSeverity;
  message: string;
}

export interface KanbanAuditSummary {
  issues: KanbanAuditIssue[];
  counts: Record<KanbanAuditSeverity, number>;
  affectedTaskCount: number;
}

export interface KanbanAuditOptions {
  /** Explicit time input keeps the audit pure, deterministic, and unit-testable. */
  now: number | Date;
  /**
   * @deprecated A valid assignment lease is the authoritative liveness
   * signal. The WebUI fleet roster only sees the connected session, so a
   * locally-unknown agent may simply be running in another session — flagging
   * it produced false "abandoned" errors. Kept for API compatibility; ignored
   * by the audit.
   */
  liveAgentIdentities?: ReadonlySet<string> | readonly string[] | undefined;
  /** Enable only when the shared Kanban task contract exposes a due date. */
  requireDueDate?: boolean | undefined;
  /** Used when the board has no review-age policy. */
  defaultReviewStaleAfterMs?: number | undefined;
}

const DEFAULT_REVIEW_STALE_AFTER_MS = 72 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set<KanbanTaskStatus>(['completed', 'archived']);

/**
 * Optional fields are read structurally so the WebUI can audit boards written by
 * newer/older Kanban packages without mutating or normalizing their payloads.
 */
type AuditableTask = KanbanTask & {
  tags?: string[] | undefined;
  subtasks?: unknown[] | undefined;
  lifecycleHistory?: unknown[] | undefined;
  statusHistory?: unknown[] | undefined;
  history?: unknown[] | undefined;
};

type LifecyclePolicy = {
  mode?: 'legacy' | 'managed' | undefined;
  managed?: boolean | undefined;
  columns?: Record<string, unknown> | undefined;
  staleReviewAfterMs?: number | undefined;
  states?: unknown[] | undefined;
  statuses?: unknown[] | undefined;
  order?: unknown[] | undefined;
  managedStatuses?: unknown[] | undefined;
  reviewStaleAfterMs?: number | undefined;
  reviewStaleHours?: number | undefined;
};

type AuditableBoard = KanbanBoard & {
  lifecycle?: LifecyclePolicy | unknown[] | undefined;
  lifecyclePolicy?: LifecyclePolicy | undefined;
  managedLifecycle?: LifecyclePolicy | unknown[] | undefined;
  reviewStaleAfterMs?: number | undefined;
};

export function auditKanbanBoard(
  board: KanbanBoard,
  options: KanbanAuditOptions,
): KanbanAuditSummary {
  const now = toEpoch(options.now);
  if (now === null) throw new TypeError('Kanban audit requires a valid current time');
  const reviewStaleAfterMs = resolveReviewStaleAfterMs(
    board as AuditableBoard,
    options.defaultReviewStaleAfterMs ?? DEFAULT_REVIEW_STALE_AFTER_MS,
  );
  const lifecycleOrder = resolveLifecycleOrder(board as AuditableBoard);
  const issues: KanbanAuditIssue[] = [];

  for (const task of board.tasks as AuditableTask[]) {
    if (TERMINAL_STATUSES.has(task.status)) continue;

    addRequiredDetailIssues(issues, task, options.requireDueDate === true);
    addRunningIssue(issues, task, now);
    addReviewIssue(issues, task, now, reviewStaleAfterMs);
    if (lifecycleOrder.length > 1) addLifecycleIssue(issues, task, lifecycleOrder);
  }

  issues.sort(compareIssues);
  return {
    issues,
    counts: {
      error: issues.filter((issue) => issue.severity === 'error').length,
      warning: issues.filter((issue) => issue.severity === 'warning').length,
    },
    affectedTaskCount: new Set(issues.map((issue) => issue.taskId)).size,
  };
}

function addRequiredDetailIssues(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  requireDueDate: boolean,
): void {
  if (!hasText(task.description)) {
    pushIssue(issues, task, 'missing-description', 'warning', 'Add a description');
  }
  if (assignmentIdentities(task).length === 0) {
    pushIssue(issues, task, 'missing-assignee', 'warning', 'Assign an owner');
  }
  if (requireDueDate && toEpoch(task.dueDate) === null) {
    pushIssue(issues, task, 'missing-due-date', 'warning', 'Set a due date');
  }
  if (!hasItems(task.labels) && !hasItems(task.tags)) {
    pushIssue(issues, task, 'missing-labels', 'warning', 'Add labels or tags');
  }
  if (!hasItems(task.childTaskIds) && !hasItems(task.subtasks)) {
    pushIssue(issues, task, 'missing-subtasks', 'warning', 'Define subtasks');
  }
  if (!hasItems(task.successCriteria)) {
    pushIssue(issues, task, 'missing-success-criteria', 'warning', 'Add success criteria');
  }
}

function addRunningIssue(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  now: number,
): void {
  const assignment = task.assignment;
  const running = task.status === 'in_progress' || assignment?.status === 'running';
  if (!running) return;

  const identities = assignmentIdentities(task);
  if (!assignment || identities.length === 0 || !hasText(assignment.leaseId) || !hasText(assignment.leaseExpiresAt)) {
    pushIssue(
      issues,
      task,
      'abandoned-running-task',
      'error',
      'Running without a complete assignment lease',
    );
    return;
  }

  const expiresAt = toEpoch(assignment.leaseExpiresAt);
  if (expiresAt === null || expiresAt <= now) {
    pushIssue(issues, task, 'stale-running-task', 'error', 'Assignment lease is expired');
    return;
  }
  // A valid lease is the authoritative liveness signal. The WebUI fleet
  // roster only knows the connected session, so a locally-unknown agent may
  // be running the task in another session — flagging it produced false
  // "abandoned" errors on healthy cross-session boards. If the agent really
  // died, the lease expires and the stale-running-task rule above catches it.
}

function addReviewIssue(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  now: number,
  staleAfterMs: number,
): void {
  if (task.status !== 'review') return;
  const enteredReviewAt = findLatestLifecycleTimestamp(task, 'review') ?? toEpoch(task.updatedAt);
  if (enteredReviewAt === null || now - enteredReviewAt <= staleAfterMs) return;

  const hours = Math.max(1, Math.floor((now - enteredReviewAt) / (60 * 60 * 1000)));
  pushIssue(issues, task, 'stale-review', 'warning', `Waiting in review for ${hours}h`);
}

function addLifecycleIssue(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  lifecycleOrder: readonly string[],
): void {
  const history = readLifecycleEntries(task);
  if (history.length < 2) return;
  const orderIndex = new Map(lifecycleOrder.map((state, index) => [normalizeIdentity(state), index]));

  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (!previous || !current) continue;
    const fromIndex = orderIndex.get(normalizeIdentity(previous.state));
    const toIndex = orderIndex.get(normalizeIdentity(current.state));
    if (fromIndex === undefined || toIndex === undefined || Math.abs(toIndex - fromIndex) <= 1) continue;

    pushIssue(
      issues,
      task,
      'skipped-lifecycle-state',
      'error',
      `Lifecycle skipped ${previous.state} → ${current.state}`,
    );
    return;
  }
}

function resolveLifecycleOrder(board: AuditableBoard): string[] {
  const candidates = [board.lifecycle, board.lifecyclePolicy, board.managedLifecycle];
  for (const candidate of candidates) {
    const direct = readStringList(candidate);
    if (direct.length > 1) return direct;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const policy = candidate as LifecyclePolicy;
    if (policy.mode === 'managed' && policy.columns) {
      const order = ['backlog', 'todo', 'running', 'review', 'done']
        .map((stage) => policy.columns?.[stage])
        .filter((value): value is string => hasText(value));
      if (order.length === 5) return order;
    }
    for (const value of [policy.states, policy.statuses, policy.order, policy.managedStatuses]) {
      const order = readStringList(value);
      if (order.length > 1) return order;
    }
  }
  return [];
}

function resolveReviewStaleAfterMs(board: AuditableBoard, fallback: number): number {
  const policies = [board, board.lifecycle, board.lifecyclePolicy, board.managedLifecycle];
  for (const candidate of policies) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const policy = candidate as LifecyclePolicy;
    if (isPositiveFinite(policy.staleReviewAfterMs)) return policy.staleReviewAfterMs;
    if (isPositiveFinite(policy.reviewStaleAfterMs)) return policy.reviewStaleAfterMs;
    if (isPositiveFinite(policy.reviewStaleHours)) return policy.reviewStaleHours * 60 * 60 * 1000;
  }
  return fallback;
}

function readLifecycleEntries(task: AuditableTask): Array<{ state: string; at: number | null }> {
  const source = task.lifecycle?.history ?? task.lifecycleHistory ?? task.statusHistory ?? task.history;
  if (!Array.isArray(source)) return [];
  const entries: Array<{ state: string; at: number | null }> = [];
  for (const raw of source) {
    if (typeof raw === 'string' && hasText(raw)) {
      entries.push({ state: raw.trim(), at: null });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const state = firstText(entry.status, entry.state, entry.toStatus, entry.to, entry.columnId);
    if (!state) continue;
    entries.push({
      state,
      at: toEpoch(entry.at ?? entry.ts ?? entry.timestamp ?? entry.changedAt ?? entry.createdAt),
    });
  }
  return entries;
}

function findLatestLifecycleTimestamp(task: AuditableTask, state: string): number | null {
  let latest: number | null = null;
  for (const entry of readLifecycleEntries(task)) {
    if (normalizeIdentity(entry.state) !== normalizeIdentity(state) || entry.at === null) continue;
    latest = latest === null ? entry.at : Math.max(latest, entry.at);
  }
  return latest;
}

function assignmentIdentities(task: AuditableTask): string[] {
  const assignment = task.assignment;
  return [
    task.assignee,
    task.assignedAgent,
    assignment?.agentId,
    assignment?.subagentId,
    assignment?.name,
  ].filter(hasText);
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const entry of value) {
    if (hasText(entry)) {
      result.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const state = firstText(record.id, record.status, record.state, record.name);
    if (state) result.push(state);
  }
  return result;
}

function normalizeIdentity(identity: string): string {
  return identity.trim().toLowerCase();
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (hasText(value)) return value.trim();
  }
  return null;
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function toEpoch(value: unknown): number | null {
  if (value instanceof Date) {
    const result = value.getTime();
    return Number.isFinite(result) ? result : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function pushIssue(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  code: KanbanAuditIssueCode,
  severity: KanbanAuditSeverity,
  message: string,
): void {
  issues.push({
    id: `${task.id}:${code}`,
    taskId: task.id,
    taskTitle: task.title,
    code,
    severity,
    message,
  });
}

function compareIssues(left: KanbanAuditIssue, right: KanbanAuditIssue): number {
  const severityDelta = severityRank(left.severity) - severityRank(right.severity);
  if (severityDelta !== 0) return severityDelta;
  const titleDelta = left.taskTitle.localeCompare(right.taskTitle);
  return titleDelta !== 0 ? titleDelta : left.message.localeCompare(right.message);
}

function severityRank(severity: KanbanAuditSeverity): number {
  return severity === 'error' ? 0 : 1;
}
