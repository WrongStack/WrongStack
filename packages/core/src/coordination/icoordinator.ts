import type { SubagentConfig } from '../types/multi-agent.js';
import type { TaskSpec, TaskResult, CoordinatorStatus } from '../types/multi-agent.js';
export type { TaskSpec, TaskResult } from '../types/multi-agent.js';

/**
 * Interface for a fleet coordinator. Implemented by both `Director`
 * (full LLM-driven orchestration with fleet policy) and
 * `DefaultMultiAgentCoordinator` (direct API-driven, no fleet policy).
 *
 * External callers — CLI slash commands, tests, the delegate tool —
 * use this to stay agnostic to the orchestration mode.
 *
 * The interface captures the **orchestration contract**: spawn, assign,
 * terminate, await, and query. Fleet-level policy (cost caps, manifest
 * writing, checkpointing) lives behind this surface and is optional
 * from the caller's perspective.
 *
 * @example
 * ```typescript
 * let coordinator: ICoordinator = new Director({ config, ... });
 * const id = await coordinator.spawn({ name: 'worker', role: 'researcher' });
 * await coordinator.assign({ id: 't-1', description: 'research X', subagentId: id });
 * const results = await coordinator.awaitTasks(['t-1']);
 * ```
 */
export interface ICoordinator {
  /** Stable identifier for this coordinator instance. */
  readonly coordinatorId: string;

  /**
   * Spawn a new subagent and return its id. In director mode this
   * enforces fleet-wide spawn caps and cost limits; in raw coordinator
   * mode it is a direct pass-through.
   */
  spawn(config: SubagentConfig): Promise<string>;

  /**
   * Assign a task to a subagent (or to the fleet for auto-routing).
   * Returns the assigned task id.
   */
  assign(task: {
    id: string;
    description: string;
    subagentId?: string | undefined;
  }): Promise<string>;

  /**
   * Synchronously ask a subagent something via the in-memory bridge.
   * The subagent must have been spawned and must handle `bridge.subscribe()`
   * in its task loop. Returns the reply payload or throws on timeout.
   *
   * Only available in director mode — raw coordinator has no bridge.
   */
  ask<T = unknown>(
    subagentId: string,
    payload: unknown,
    timeoutMs?: number,
  ): Promise<T> | undefined;

  /**
   * Wait for one or more tasks to complete and return their results.
   * If a task is already done when called, returns immediately.
   * Resolves to an array in the same order as `taskIds`.
   */
  awaitTasks(taskIds: string[]): Promise<TaskResult[]>;

  /**
   * Gracefully stop a single subagent. The subagent finishes its current
   * in-flight work and exits cleanly — it does not hard-kill.
   */
  terminate(subagentId: string): Promise<void>;

  /**
   * Stop all subagents. In-flight tasks are allowed to complete;
   * no new tasks are dispatched.
   */
  terminateAll(): Promise<void>;

  /**
   * Stop a subagent and remove it from the coordinator. Releases all
   * associated resources (AbortController, budget state). The subagent
   * entry is deleted so the id can be reused in a future spawn.
   */
  remove(subagentId: string): Promise<void>;

  /**
   * Live coordinator status — subagent list, pending task count,
   * completed task count, iteration totals.
   */
  status(): CoordinatorStatus;

  /**
   * Snapshot of completed task results. In director mode this returns
   * every `TaskResult` from the fleet; in raw coordinator mode this
   * may return an empty array if the coordinator doesn't cache results.
   */
  completedResults(): TaskResult[];

  /**
   * Subscribe to coordinator lifecycle events. Currently supports
   * `task.completed` — the payload carries the task spec and result.
   *
   * Returns a disposer function; call it to unsubscribe.
   */
  on(
    event: 'task.completed',
    handler: (payload: { task: TaskSpec; result: TaskResult }) => void,
  ): () => void;
}
