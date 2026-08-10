/**
 * `kanban-audit.ts` — Pure, dependency-free Kanban Cleaner audit for the TUI.
 *
 * Mirrors the WebUI's `packages/webui/src/lib/kanban-cleaner.ts` but
 * lives in the TUI package so we don't have to thread `@wrongstack/webui`
 * (which depends on React) into a server-side TUI pipeline.
 *
 * The two implementations must produce the same verdicts for the same board.
 * That claim used to be a comment; it is now enforced by
 * `packages/cli/tests/kanban-cleaner-parity.test.ts`, which runs a shared
 * corpus through both and compares the `taskId:code:severity` triples. Only
 * three differences are deliberate, and all three are API shape rather than
 * verdict: this file also accepts `liveAgentIdentities`, returns eight extra
 * summary fields the WebUI's `KanbanCleanerAlert` fills from queue health, and
 * exports `summarizeAuditHeadline` / `topAuditIssues` for the panel badge.
 * Messages may differ; codes and severities may not.
 *
 * The output of `auditKanbanBoard()` feeds the TUI panel header badge so
 * users see Cleaner warnings inline — mirroring the WebUI's
 * `KanbanCleanerAlert` component, but inline-pinned to the project root.
 */
import type {
  KanbanAgentAssignment,
  KanbanBoard,
  KanbanTask,
  KanbanTaskStatus,
} from '@wrongstack/kanban';

export type KanbanAuditSeverity = 'error' | 'warning';

/**
 * The audit vocabulary, as a runtime value so the parity test can compare the
 * two implementations' code sets instead of trusting that both type unions
 * were edited together.
 */
export const ALL_AUDIT_CODES = [
  'abandoned-running-task',
  'board-oversized',
  'missing-assignee',
  'missing-description',
  'missing-due-date',
  'missing-labels',
  'missing-subtasks',
  'missing-success-criteria',
  'skipped-lifecycle-state',
  'stale-review',
  'stale-running-task',
] as const;

export type KanbanAuditIssueCode = (typeof ALL_AUDIT_CODES)[number];

export interface KanbanAuditIssue {
  id: string;
  taskId: string;
  taskTitle: string;
  code: KanbanAuditIssueCode;
  severity: KanbanAuditSeverity;
  message: string;
}

export interface KanbanAuditSummary {
  /** Wall-clock time the audit ran (ISO-8601). Used by the renderer to
   *  label the report and by tests to pin the audit's age. */
  generatedAt: string;
  /** IDs of every board this summary aggregated across. */
  boardIds: readonly string[];
  /** Aggregate severity counters. */
  counts: Readonly<Record<KanbanAuditSeverity, number>>;
  /** Detail buckets surfaced by the WebUI Cleaner `KanbanCleanerAlert`.
   *  Each entry lists the tasks that triggered the signal. */
  dependencyBlocked: {
    count: number;
    tasks: ReadonlyArray<{ board: { title: string }; task: { title: string } }>;
  };
  staleAssignments: {
    count: number;
    tasks: ReadonlyArray<{ board: { title: string }; task: { title: string } }>;
  };
  failedRetryable: {
    count: number;
    tasks: ReadonlyArray<{ board: { title: string }; task: { title: string } }>;
  };
  heartbeatDue: {
    count: number;
    tasks: ReadonlyArray<{ board: { title: string }; task: { title: string } }>;
  };
  /** Activity stamps for last dispatch / last recovery. */
  lastDispatchedAt: string | undefined;
  lastStaleRecoveredAt: string | undefined;
  /** All issues raised by the audit, sorted error-first. */
  issues: readonly KanbanAuditIssue[];
  /** Distinct task IDs across `issues`. */
  affectedTaskCount: number;
}

export interface KanbanAuditOptions {
  /** Explicit time input keeps the audit pure, deterministic, and unit-testable. */
  now: number | Date;
  /** IDs or names of agents currently reported as running by the WebUI fleet roster. */
  liveAgentIdentities?: ReadonlySet<string> | readonly string[] | undefined;
  /** Enable only when the shared Kanban task contract exposes a due date. */
  requireDueDate?: boolean | undefined;
  /** Used when the board has no review-age policy. */
  defaultReviewStaleAfterMs?: number | undefined;
}

const DEFAULT_REVIEW_STALE_AFTER_MS = 72 * 60 * 60 * 1000;
const TERMINAL_STATUSES = new Set<KanbanTaskStatus>(['completed', 'archived']);

/**
 * Mirror of `KANBAN_BOARD_SOFT_MAX_BYTES` (`@wrongstack/kanban`, storage.ts).
 * Inlined rather than imported because the WebUI half of this audit cannot
 * pull a runtime value out of that package's barrel — it reaches `node:net`.
 * `kanban-cleaner-parity.test.ts` pins both copies to the exported constant.
 */
const BOARD_SOFT_MAX_BYTES = 512 * 1024;

/* ------------------------------------------------------------------ */
/* Optional-field widening — keep this in lock-step with @wrongstack/kanban */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Public API                                                            */
/* ------------------------------------------------------------------ */

export function auditKanbanBoard(
  board: KanbanBoard,
  options: KanbanAuditOptions,
): KanbanAuditSummary {
  const now = toEpoch(options.now);
  if (now === null) throw new TypeError('Kanban audit requires a valid current time');
  const liveIdentities =
    options.liveAgentIdentities === undefined
      ? undefined
      : normalizeIdentities(options.liveAgentIdentities);
  const auditableBoard = board as AuditableBoard;
  const reviewStaleAfterMs = resolveReviewStaleAfterMs(
    auditableBoard,
    options.defaultReviewStaleAfterMs ?? DEFAULT_REVIEW_STALE_AFTER_MS,
  );
  const lifecycleOrder = resolveLifecycleOrder(auditableBoard);
  const managed = isManagedBoard(auditableBoard);
  // A managed board does NOT imply a required due date. The lifecycle gate
  // (`validateRequiredCardDetails`) demands description, assignee, success
  // criteria and — for atomic parents — child tasks; a date is never part of
  // advancing a card. Auto-enabling it here made the Cleaner disagree with the
  // gate on every managed board, and ignored a caller that passed `false`.
  const requireDueDate = options.requireDueDate === true;
  const issues: KanbanAuditIssue[] = [];

  for (const task of board.tasks as AuditableTask[]) {
    // Completed and archived cards are done being audited. Reporting a skipped
    // lifecycle transition on them was noise about work already delivered.
    if (TERMINAL_STATUSES.has(task.status)) continue;

    addRequiredDetailIssues(issues, task, requireDueDate, managed);
    addRunningIssue(issues, task, now, liveIdentities);
    addReviewIssue(issues, task, now, reviewStaleAfterMs);
    if (lifecycleOrder.length > 1) addLifecycleIssue(issues, task, lifecycleOrder);
  }
  addBoardSizeIssue(issues, board);

  issues.sort(compareIssues);
  return {
    generatedAt: new Date(now).toISOString(),
    boardIds: [board.id],
    counts: {
      error: issues.filter((issue) => issue.severity === 'error').length,
      warning: issues.filter((issue) => issue.severity === 'warning').length,
    },
    dependencyBlocked: { count: 0, tasks: [] },
    staleAssignments: { count: 0, tasks: [] },
    failedRetryable: { count: 0, tasks: [] },
    heartbeatDue: { count: 0, tasks: [] },
    lastDispatchedAt: undefined,
    lastStaleRecoveredAt: undefined,
    issues,
    affectedTaskCount: new Set(issues.map((issue) => issue.taskId)).size,
  };
}

/* ------------------------------------------------------------------ */
/* Headline helpers — let the TUI render a single summary string       */
/* ------------------------------------------------------------------ */

/**
 * Short headline string used by the panel header badge. Returns null when
 * the summary is empty so callers can hide the badge entirely instead of
 * rendering a noisy "0 warnings" chip.
 */
export function summarizeAuditHeadline(summary: KanbanAuditSummary): string | null {
  const total = summary.counts.error + summary.counts.warning;
  if (total === 0) return null;
  const parts: string[] = [];
  if (summary.counts.error > 0) parts.push(`${summary.counts.error} error`);
  if (summary.counts.warning > 0) parts.push(`${summary.counts.warning} warning`);
  return `${total} cleaner ${total === 1 ? 'issue' : 'issues'} (${parts.join(' · ')})`;
}

/**
 * Top-N issues, biased toward `error` severity first. The TUI panel
 * surfaces these inline; the full list is still available via
 * `summary.issues` for tooling.
 *
 * We sort defensively (rather than rely on `auditKanbanBoard`'s in-place
 * order) so callers that hand us a manually-built summary — for example
 * a test fixture, or a future caller that aggregates issues from
 * multiple boards — still get the error-first ordering.
 */
export function topAuditIssues(
  summary: KanbanAuditSummary,
  limit = 3,
): readonly KanbanAuditIssue[] {
  const sorted = [...summary.issues].sort(compareIssues);
  return sorted.slice(0, Math.max(0, limit));
}

/* ------------------------------------------------------------------ */
/* Issue collectors — shared semantics with @wrongstack/webui           */
/* ------------------------------------------------------------------ */

function addRequiredDetailIssues(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  requireDueDate: boolean,
  managed: boolean,
): void {
  if (!hasText(task.description)) {
    pushIssue(issues, task, 'missing-description', 'warning', 'Add a description');
  }
  const hasAssignee = managed
    ? [task.assignee, task.assignedAgent, task.assignment?.agentId, task.assignment?.name].some(
        hasText,
      )
    : assignmentIdentities(task).length > 0;
  if (!hasAssignee) {
    pushIssue(issues, task, 'missing-assignee', 'warning', 'Assign an owner');
  }
  // `toEpoch` also accepts a number or a `Date`. Boards written by older
  // packages store epoch millis, and demanding a string flagged them all.
  if (requireDueDate && toEpoch(task.dueDate) === null) {
    pushIssue(issues, task, 'missing-due-date', 'warning', 'Set a valid due date');
  }
  if (!hasTextItem(task.labels) && (managed || !hasTextItem(task.tags))) {
    pushIssue(
      issues,
      task,
      'missing-labels',
      'warning',
      managed ? 'Add at least one label' : 'Add labels or tags',
    );
  }
  if (!hasTextItem(task.childTaskIds) && (managed || !hasMeaningfulSubtask(task.subtasks))) {
    pushIssue(
      issues,
      task,
      'missing-subtasks',
      'warning',
      managed ? 'Persist at least one child task' : 'Define subtasks',
    );
  }
  if (!hasValidSuccessCriteria(task.successCriteria, managed)) {
    pushIssue(issues, task, 'missing-success-criteria', 'warning', 'Add success criteria');
  }
}

/**
 * The one board-level finding. Every other code names a card; this one names
 * the board, so it carries the board id in `taskId` and the board title in
 * `taskTitle` — which also means an oversized board adds one to
 * `affectedTaskCount`.
 *
 * Why it matters: nothing enforces a board size limit, but the HQ wire codec
 * silently drops any single board record over ~750 KB. Before this code
 * existed a board simply stopped appearing in HQ with no signal anywhere.
 */
function addBoardSizeIssue(issues: KanbanAuditIssue[], board: KanbanBoard): void {
  const bytes = boardByteSize(board);
  if (bytes <= BOARD_SOFT_MAX_BYTES) return;
  issues.push({
    id: `${board.id}:board-oversized`,
    taskId: board.id,
    taskTitle: board.title,
    code: 'board-oversized',
    severity: 'warning',
    message: `Board is ~${Math.round(bytes / 1024)} KB across ${board.tasks.length} cards; archive completed cards before it stops syncing to HQ`,
  });
}

function boardByteSize(board: KanbanBoard): number {
  try {
    return JSON.stringify(board)?.length ?? 0;
  } catch {
    // A board that cannot be serialized cannot be measured — and cannot reach
    // HQ either, but that is a different problem than being too large.
    return 0;
  }
}

function addRunningIssue(
  issues: KanbanAuditIssue[],
  task: AuditableTask,
  now: number,
  liveIdentities: ReadonlySet<string> | undefined,
): void {
  const assignment: KanbanAgentAssignment | undefined = task.assignment;
  const running = task.status === 'in_progress' || assignment?.status === 'running';
  if (!running) return;

  const identities = assignmentIdentities(task);
  const leaseOk = [
    assignment?.leaseId,
    assignment?.claimedAt,
    assignment?.heartbeatAt,
    assignment?.leaseExpiresAt,
  ].every((value) => hasText(value));
  if (assignment?.status !== 'running' || identities.length === 0 || !leaseOk) {
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

  // `undefined` means fleet data was unavailable. A supplied empty set is
  // authoritative: the host checked the fleet and found no live agents.
  if (
    liveIdentities !== undefined &&
    !identities.some((identity) => liveIdentities.has(normalizeIdentity(identity)))
  ) {
    pushIssue(issues, task, 'abandoned-running-task', 'error', 'Assigned agent is not live');
  }
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
  const orderIndex = new Map(
    lifecycleOrder.map((state, index) => [normalizeIdentity(state), index]),
  );

  for (let index = 1; index < history.length; index += 1) {
    const previous = history[index - 1];
    const current = history[index];
    if (!previous || !current) continue;
    const fromIndex = orderIndex.get(normalizeIdentity(previous.state));
    const toIndex = orderIndex.get(normalizeIdentity(current.state));
    if (fromIndex === undefined || toIndex === undefined || Math.abs(toIndex - fromIndex) <= 1)
      continue;

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

/* ------------------------------------------------------------------ */
/* Policy resolution                                                    */
/* ------------------------------------------------------------------ */

function isManagedBoard(board: AuditableBoard): boolean {
  return [board.lifecycle, board.lifecyclePolicy, board.managedLifecycle].some(
    (candidate) =>
      !!candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      (candidate as LifecyclePolicy).mode === 'managed',
  );
}

function resolveLifecycleOrder(board: AuditableBoard): string[] {
  const candidates = [board.lifecycle, board.lifecyclePolicy, board.managedLifecycle];
  for (const candidate of candidates) {
    const direct = readStringList(candidate);
    if (direct.length > 1) return direct;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const policy = candidate as LifecyclePolicy;
    if (policy.mode === 'managed' && policy.columns) {
      // Task lifecycle history persists canonical stages, not board column IDs.
      return ['backlog', 'todo', 'running', 'review', 'done'];
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
  const source =
    task.lifecycle?.history ?? task.lifecycleHistory ?? task.statusHistory ?? task.history;
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

function normalizeIdentities(values: KanbanAuditOptions['liveAgentIdentities']): Set<string> {
  const normalized = new Set<string>();
  if (!values) return normalized;
  for (const value of values) {
    if (hasText(value)) normalized.add(normalizeIdentity(value));
  }
  return normalized;
}

function normalizeIdentity(value: string): string {
  // Not `toLocaleLowerCase` — under a Turkish locale that maps "I" to "ı",
  // so an agent named "IndexBot" would stop matching its own lease.
  return value.trim().toLowerCase();
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

function hasTextItem(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasText);
}

function hasMeaningfulSubtask(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    if (hasText(item)) return true;
    if (!item || typeof item !== 'object') return false;
    const record = item as Record<string, unknown>;
    return [record.id, record.taskId, record.title, record.description].some(hasText);
  });
}

function hasValidSuccessCriteria(value: unknown, managed: boolean): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((criterion) => {
      if (!managed && hasText(criterion)) return true;
      return (
        !!criterion &&
        typeof criterion === 'object' &&
        hasText((criterion as Record<string, unknown>).description)
      );
    })
  );
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
