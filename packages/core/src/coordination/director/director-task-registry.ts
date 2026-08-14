import { randomUUID } from 'node:crypto';
import type { DirectorStateCheckpoint } from '../../storage/director-state.js';
import type {
  AwaitAnyResult,
  MultiAgentCoordinator,
  TaskResult,
  TaskSpec,
} from '../../types/multi-agent.js';
import type { SessionWriter } from '../../types/session.js';
import { formatSubagentStructuredReport } from '../subagent-result-tool.js';

type TaskCoordinator = Pick<
  MultiAgentCoordinator,
  'assign' | 'listPendingTasks' | 'retargetPendingTask'
>;

export interface DirectorTaskRegistryDeps {
  coordinator: TaskCoordinator;
  stateCheckpoint: DirectorStateCheckpoint | null;
  isWorkComplete(): boolean;
  addTaskToManifest(subagentId: string, taskId: string): void;
  recordPendingTask(taskId: string, subagentId: string, description: string): void;
  appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void>;
  scheduleManifest(): void;
  getSubagentMeta(
    subagentId: string,
  ): { provider?: string | undefined; model?: string | undefined } | undefined;
}

interface AnyWaiter {
  ids: ReadonlySet<string>;
  resolve(result: TaskResult): void;
  timer?: ReturnType<typeof setTimeout> | undefined;
}

export interface SettledTask {
  internal: boolean;
  consumedInBand: boolean;
}

/** Owns task identity, result retention, ownership, and waiter semantics. */
export class DirectorTaskRegistry {
  private static readonly MAX_COMPLETED = 10_000;

  private readonly completed = new Map<string, TaskResult>();
  private readonly taskWaiters = new Map<
    string,
    { promise: Promise<TaskResult>; resolve: (result: TaskResult) => void }
  >();
  private readonly anyWaiters = new Set<AnyWaiter>();
  private readonly descriptions = new Map<string, string>();
  private readonly owners = new Map<string, string>();
  private readonly internalTaskIds = new Set<string>();

  constructor(private readonly deps: DirectorTaskRegistryDeps) {}

  settle(result: TaskResult): SettledTask {
    const internal = this.internalTaskIds.delete(result.taskId);
    if (!internal) {
      this.completed.set(result.taskId, result);
      this.trimCompletedResults();
    }

    const waiter = this.taskWaiters.get(result.taskId);
    if (waiter) {
      waiter.resolve(result);
      this.taskWaiters.delete(result.taskId);
    }

    let anyConsumed = false;
    for (const entry of [...this.anyWaiters]) {
      if (!entry.ids.has(result.taskId)) continue;
      if (entry.timer) clearTimeout(entry.timer);
      this.anyWaiters.delete(entry);
      entry.resolve(result);
      anyConsumed = true;
    }
    return { internal, consumedInBand: waiter !== undefined || anyConsumed };
  }

  async assign(task: TaskSpec): Promise<string> {
    const taskWithId: TaskSpec = task.id ? task : { ...task, id: randomUUID() };
    if (this.deps.isWorkComplete()) {
      const stopped = this.makeStoppedResult(
        taskWithId.id,
        taskWithId.subagentId ?? 'unassigned',
        'Director called workComplete() — no further tasks will run',
      );
      this.settle(stopped);
      return taskWithId.id;
    }

    if (taskWithId.subagentId) {
      this.deps.addTaskToManifest(taskWithId.subagentId, taskWithId.id);
    }
    await this.deps.coordinator.assign(taskWithId);
    this.descriptions.set(taskWithId.id, taskWithId.description);
    if (taskWithId.subagentId) this.owners.set(taskWithId.id, taskWithId.subagentId);
    this.recordAssignment(taskWithId);
    return taskWithId.id;
  }

  async assignInternal(task: TaskSpec): Promise<string> {
    const taskWithId: TaskSpec = task.id ? task : { ...task, id: randomUUID() };
    this.internalTaskIds.add(taskWithId.id);
    try {
      await this.deps.coordinator.assign(taskWithId);
    } catch (error) {
      this.internalTaskIds.delete(taskWithId.id);
      throw error;
    }
    return taskWithId.id;
  }

  awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return Promise.all(taskIds.map((id) => this.awaitTask(id)));
  }

  awaitTasksAny(taskIds: string[], opts?: { timeoutMs?: number }): Promise<AwaitAnyResult> {
    const completed = taskIds
      .map((id) => this.completed.get(id))
      .filter((result): result is TaskResult => result !== undefined);
    if (completed.length > 0 || taskIds.length === 0) {
      const done = new Set(completed.map((result) => result.taskId));
      return Promise.resolve({
        completed,
        pending: taskIds.filter((id) => !done.has(id)),
      });
    }

    return new Promise<AwaitAnyResult>((resolve) => {
      const entry: AnyWaiter = {
        ids: new Set(taskIds),
        resolve: (result) =>
          resolve({
            completed: [result],
            pending: taskIds.filter((id) => id !== result.taskId),
          }),
      };
      if (opts?.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.anyWaiters.delete(entry);
          resolve({ completed: [], pending: [...taskIds], timedOut: true });
        }, opts.timeoutMs);
      }
      this.anyWaiters.add(entry);
    });
  }

  listPendingTasks(): readonly TaskSpec[] {
    return this.deps.coordinator.listPendingTasks();
  }

  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean {
    if (!this.deps.coordinator.retargetPendingTask(taskId, subagentId)) return false;
    if (subagentId) {
      this.owners.set(taskId, subagentId);
      this.deps.addTaskToManifest(subagentId, taskId);
    } else {
      this.owners.delete(taskId);
    }
    const description = this.descriptions.get(taskId) ?? taskId;
    this.deps.recordPendingTask(taskId, subagentId ?? '', description);
    this.deps.stateCheckpoint?.recordTaskAssigned({
      taskId,
      subagentId,
      description,
      status: 'running',
      assignedAt: new Date().toISOString(),
    });
    this.deps.scheduleManifest();
    return true;
  }

  rollUp(taskIds: string[], style: 'markdown' | 'json' = 'markdown'): string {
    const rows = taskIds
      .map((id) => this.completed.get(id))
      .filter((result): result is TaskResult => result !== undefined);
    if (style === 'json') return this.toJson(rows);
    if (rows.length === 0) {
      return '_No completed tasks for the requested ids — try waiting first._';
    }
    const lines: string[] = [];
    for (const result of rows) {
      const meta = this.deps.getSubagentMeta(result.subagentId);
      const tag = meta?.provider && meta.model ? ` · ${meta.provider}/${meta.model}` : '';
      lines.push(`### ${result.subagentId}${tag}`);
      lines.push(
        `_${result.status} — ${result.iterations} iter · ${result.toolCalls} tools · ${result.durationMs}ms_`,
        '',
      );
      if (result.error) lines.push(`**Error:** ${result.error}`);
      else if (result.report) lines.push(formatSubagentStructuredReport(result.report));
      else if (typeof result.result === 'string') lines.push(result.result);
      else if (result.result !== undefined) {
        lines.push(`\`\`\`json\n${JSON.stringify(result.result, null, 2)}\n\`\`\``);
      } else lines.push('_(no output)_');
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  completedResult(taskId: string): TaskResult | undefined {
    return this.completed.get(taskId);
  }

  completedResults(): TaskResult[] {
    return Array.from(this.completed.values());
  }

  descriptionFor(taskId: string, fallback: string): string {
    return this.descriptions.get(taskId) ?? fallback;
  }

  ownerFor(taskId: string): string | undefined {
    return this.owners.get(taskId);
  }

  removeTasks(taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      this.owners.delete(taskId);
      this.descriptions.delete(taskId);
    }
  }

  /**
   * Remove every task owned by `subagentId` from the descriptions/owners
   * indexes and return the removed task ids. Director.remove() calls this so
   * per-task state is reclaimed on the default FleetManager path too, where
   * the Director's manifestEntries map is never populated (fleet-spawn.ts:289
   * fills it only when !host.fleetManager) and the manifest-gated removeTasks
   * call would otherwise be skipped — leaking one description (a full task
   * brief, KB-scale) plus one owner entry per assigned task for the Director's
   * lifetime. The owners index is populated on every path (assign/retarget),
   * so this works with or without a FleetManager. Idempotent with removeTasks.
   */
  removeTasksOwnedBy(subagentId: string): string[] {
    const removed: string[] = [];
    for (const [taskId, owner] of this.owners) {
      if (owner === subagentId) removed.push(taskId);
    }
    this.removeTasks(removed);
    return removed;
  }

  resolveWaitersOnShutdown(): void {
    for (const entry of [...this.anyWaiters]) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(this.makeStoppedResult([...entry.ids][0] ?? 'unknown', 'director'));
    }
    this.anyWaiters.clear();
    for (const [taskId, waiter] of this.taskWaiters) {
      waiter.resolve(this.makeStoppedResult(taskId, 'director'));
    }
    this.taskWaiters.clear();
  }

  /** A task the registry could still settle: completed, currently assigned, or internal. */
  private isKnownTask(taskId: string): boolean {
    return (
      this.completed.has(taskId) ||
      this.descriptions.has(taskId) ||
      this.owners.has(taskId) ||
      this.internalTaskIds.has(taskId) ||
      this.taskWaiters.has(taskId)
    );
  }

  private awaitTask(taskId: string): Promise<TaskResult> {
    const cached = this.completed.get(taskId);
    if (cached) return Promise.resolve(cached);
    const existing = this.taskWaiters.get(taskId);
    if (existing) return existing.promise;
    // A taskId the registry has never seen — a leader typo/hallucination, or an
    // id that was passed to await_tasks before it was ever assigned — can never
    // be settle()d, so a waiter for it would hang the entire await_tasks call
    // (and, on the kanban path, keep renewing the lease for hours). Return a
    // synthetic stopped result immediately instead.
    if (!this.isKnownTask(taskId)) {
      return Promise.resolve(
        this.makeStoppedResult(taskId, 'director', `Unknown task id "${taskId}" — never assigned`),
      );
    }
    let resolve!: (result: TaskResult) => void;
    const promise = new Promise<TaskResult>((done) => {
      resolve = done;
    });
    this.taskWaiters.set(taskId, { promise, resolve });
    return promise;
  }

  private recordAssignment(task: TaskSpec): void {
    const assignedAt = new Date().toISOString();
    this.deps.stateCheckpoint?.recordTaskAssigned({
      taskId: task.id,
      subagentId: task.subagentId,
      description: task.description,
      status: 'running',
      assignedAt,
    });
    void this.deps.appendSessionEvent({
      type: 'task_created',
      ts: assignedAt,
      taskId: task.id,
      title: task.description,
    });
    this.deps.scheduleManifest();
  }

  private trimCompletedResults(): void {
    const overflow = this.completed.size - DirectorTaskRegistry.MAX_COMPLETED;
    if (overflow <= 0) return;
    for (const taskId of [...this.completed.keys()].slice(0, overflow)) {
      this.completed.delete(taskId);
      this.descriptions.delete(taskId);
      this.owners.delete(taskId);
    }
  }

  private makeStoppedResult(taskId: string, subagentId: string, message?: string): TaskResult {
    return {
      taskId,
      subagentId,
      status: 'stopped',
      ...(message
        ? { error: { kind: 'aborted_by_parent' as const, message, retryable: false } }
        : {}),
      iterations: 0,
      toolCalls: 0,
      durationMs: 0,
    };
  }

  private toJson(rows: TaskResult[]): string {
    return JSON.stringify(
      rows.map((result) => ({
        taskId: result.taskId,
        subagentId: result.subagentId,
        status: result.status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
        result: result.result,
        report: result.report,
        error: result.error,
      })),
      null,
      2,
    );
  }
}
