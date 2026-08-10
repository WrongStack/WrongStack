import type { EventBus } from '@wrongstack/core/kernel';
import type { TaskTracker } from '@wrongstack/core/tasking';
import type { Specification, TaskGraph, TaskNode } from '@wrongstack/core/types';
import { analyzeCriticalPath } from './critical-path.js';
import {
  assertSpecTaskGraphCoverage,
  assertTaskGraphExecutionIntegrity,
} from './requirement-coverage.js';

export interface AutoExecutorOptions {
  tracker: TaskTracker;
  events: EventBus;
  /** Maximum concurrent tasks. Defaults to 1 (sequential). */
  maxConcurrent?: number | undefined;
  /** Maximum retry attempts for failed tasks. */
  maxRetries?: number | undefined;
  /** Custom task executor function. */
  executeTask: (task: TaskNode, context: TaskExecutionContext) => Promise<TaskExecutionResult>;
  /** Called before each task starts. */
  onTaskStart?: ((task: TaskNode) => void) | undefined;
  /** Called after each task completes. */
  onTaskComplete?: (task: TaskNode, result: TaskExecutionResult) => void;
  /** Called when a task fails. */
  onTaskFail?: (task: TaskNode, error: Error, retryCount: number) => void;
  /** Called when all tasks are done or no more can execute. */
  onDone?: ((summary: ExecutionSummary) => void) | undefined;
}

export interface TaskExecutionContext {
  /** The spec being implemented. */
  spec: Specification;
  /** The full task graph. */
  graph: TaskGraph;
  /** The current task being executed. */
  task: TaskNode;
  /** Tasks that this task depends on. */
  dependencies: TaskNode[];
  /** Tasks that depend on this task. */
  dependents: TaskNode[];
  /** Retry count for this task (0 = first attempt). */
  retryCount: number;
}

export interface TaskExecutionResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
  /** If true, the task will be retried. */
  retry?: boolean | undefined;
}

export interface ExecutionSummary {
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  retried: number;
  duration: number;
  criticalPath: string[];
}

/**
 * Auto-executor that drives task execution with dependency resolution,
 * retry logic, and critical path awareness.
 */
export class AutoExecutor {
  private readonly opts: AutoExecutorOptions;
  private stopped = false;
  private retryMap = new Map<string, number>();

  constructor(opts: AutoExecutorOptions) {
    this.opts = opts;
  }

  /**
   * Execute all tasks in the graph, respecting dependencies.
   */
  async execute(graph: TaskGraph, spec: Specification): Promise<ExecutionSummary> {
    assertSpecTaskGraphCoverage(graph, spec);
    assertTaskGraphExecutionIntegrity(graph);
    this.stopped = false;
    this.retryMap.clear();
    const startTime = Date.now();

    const critical = analyzeCriticalPath(graph);
    let completed = 0;
    let failed = 0;
    const skipped = 0;
    let retried = 0;

    while (!this.stopped) {
      const readyTasks = this.getReadyTasks(graph);

      if (readyTasks.length === 0) {
        // Check if all tasks are done
        const allDone = Array.from(graph.nodes.values()).every(
          (n) => n.status === 'completed' || n.status === 'failed',
        );
        if (allDone) break;

        // Check for deadlock (all remaining tasks are blocked by failed tasks)
        const hasDeadlock = this.detectDeadlock(graph);
        if (hasDeadlock) break;

        break;
      }

      // Execute batch
      const batch = readyTasks.slice(0, this.opts.maxConcurrent ?? 1);

      const results = await Promise.allSettled(
        batch.map((task) => this.executeTaskWithRetry(task, graph, spec)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i]!;
        const task = batch[i]!;

        if (result.status === 'fulfilled') {
          const { result: execResult, retries } = result.value;
          if (execResult.success) {
            this.opts.tracker.updateNodeStatus(task.id, 'completed');
            completed++;
            if (retries > 0) retried++;
            this.opts.onTaskComplete?.(task, execResult);
          } else if (execResult.retry) {
            retried++;
            // Task will be retried on next iteration
          } else {
            this.opts.tracker.updateNodeStatus(task.id, 'failed', execResult.error);
            failed++;
          }
        } else {
          this.opts.tracker.updateNodeStatus(task.id, 'failed', String(result.reason));
          failed++;
          this.opts.onTaskFail?.(task, result.reason as Error, 0);
        }
      }
    }

    const duration = Date.now() - startTime;
    const summary: ExecutionSummary = {
      total: graph.nodes.size,
      completed,
      failed,
      skipped,
      retried,
      duration,
      criticalPath: critical.criticalPath,
    };

    this.opts.onDone?.(summary);
    return summary;
  }

  /** Stop execution. */
  stop(): void {
    this.stopped = true;
  }

  /** Get tasks that are ready to execute (all dependencies completed). */
  private getReadyTasks(graph: TaskGraph): TaskNode[] {
    const ready: TaskNode[] = [];

    for (const node of graph.nodes.values()) {
      if (node.status !== 'pending') continue;

      // Check if all blockers are completed
      const blockers = graph.edges
        .filter((e) => e.type === 'depends_on' && e.to === node.id)
        .map((e) => graph.nodes.get(e.from))
        .filter(Boolean) as TaskNode[];

      const allBlockersDone = blockers.every((b) => b.status === 'completed');
      if (allBlockersDone) {
        ready.push(node);
      }
    }

    // Sort by priority
    const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    ready.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return ready;
  }

  /** Execute a single task with retry logic. */
  private async executeTaskWithRetry(
    task: TaskNode,
    graph: TaskGraph,
    spec: Specification,
  ): Promise<{ result: TaskExecutionResult; retries: number }> {
    const maxRetries = this.opts.maxRetries ?? 2;
    let retryCount = this.retryMap.get(task.id) ?? 0;

    while (true) {
      this.opts.tracker.updateNodeStatus(task.id, 'in_progress');
      this.opts.onTaskStart?.(task);

      const dependencies = this.getTaskDependencies(task.id, graph);
      const dependents = this.getTaskDependents(task.id, graph);

      const context: TaskExecutionContext = {
        spec,
        graph,
        task,
        dependencies,
        dependents,
        retryCount,
      };

      try {
        const result = await this.opts.executeTask(task, context);

        if (result.success) {
          const retriesForTask = this.retryMap.get(task.id) ?? 0;
          this.retryMap.delete(task.id);
          return { result, retries: retriesForTask };
        }

        if (result.retry && retryCount < maxRetries) {
          retryCount++;
          this.retryMap.set(task.id, retryCount);
          this.opts.tracker.updateNodeStatus(task.id, 'pending');
          continue;
        }

        return { result, retries: retryCount };
      } catch (error) {
        if (retryCount < maxRetries) {
          retryCount++;
          this.retryMap.set(task.id, retryCount);
          this.opts.tracker.updateNodeStatus(task.id, 'pending');
          this.opts.onTaskFail?.(task, error as Error, retryCount);
          continue;
        }

        return {
          result: {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          },
          retries: retryCount,
        };
      }
    }
  }

  /** Get tasks that this task depends on. */
  private getTaskDependencies(taskId: string, graph: TaskGraph): TaskNode[] {
    return graph.edges
      .filter((e) => e.type === 'depends_on' && e.to === taskId)
      .map((e) => graph.nodes.get(e.from))
      .filter(Boolean) as TaskNode[];
  }

  /** Get tasks that depend on this task. */
  private getTaskDependents(taskId: string, graph: TaskGraph): TaskNode[] {
    return graph.edges
      .filter((e) => e.type === 'depends_on' && e.from === taskId)
      .map((e) => graph.nodes.get(e.to))
      .filter(Boolean) as TaskNode[];
  }

  /** Detect deadlock: all remaining tasks are blocked by failed tasks. */
  private detectDeadlock(graph: TaskGraph): boolean {
    const remaining = Array.from(graph.nodes.values()).filter(
      (n) => n.status === 'pending' || n.status === 'blocked',
    );

    if (remaining.length === 0) return false;

    return remaining.every((node) => {
      const blockers = graph.edges
        .filter((e) => e.type === 'depends_on' && e.to === node.id)
        .map((e) => graph.nodes.get(e.from))
        .filter(Boolean) as TaskNode[];

      return blockers.some((b) => b.status === 'failed');
    });
  }
}

/**
 * Create an auto-executor that works with TaskFlow.
 */
export function createAutoExecutor(opts: {
  tracker: TaskTracker;
  events: EventBus;
  executeTask: AutoExecutorOptions['executeTask'];
  maxConcurrent?: number | undefined;
  maxRetries?: number | undefined;
}): AutoExecutor {
  return new AutoExecutor({
    tracker: opts.tracker,
    events: opts.events,
    executeTask: opts.executeTask,
    maxConcurrent: opts.maxConcurrent,
    maxRetries: opts.maxRetries,
  });
}
