import type { EventBus } from '@wrongstack/core/kernel';
import { DefaultTaskStore, TaskTracker } from '@wrongstack/core/tasking';
import type {
  DoneCondition,
  SpecAnalysis,
  Specification,
  TaskGraph,
  TaskNode,
} from '@wrongstack/core/types';
import { ERROR_CODES, SddError } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { SpecParser } from './spec-parser.js';
import { TaskGenerator } from './task-generator.js';

/**
 * Extended event map used internally by TaskFlow and multi-agent components.
 * These events are emitted on the injected EventBus and are a subset of
 * the full EventMap — they do not require a separate registration.
 */
export interface TaskFlowEventMap {
  'phase.change': { from: TaskFlowPhase; to: TaskFlowPhase };
  'task.started': { taskId: string };
  'task.completed': { taskId: string; result?: unknown | undefined };
  'task.failed': { taskId: string; error: string };
  'task.review': { taskId: string };
  'spec.analyzed': { analysis: SpecAnalysis };
  progress: { percent: number; message: string };
  done: { graph: TaskGraph };
  error: { phase: TaskFlowPhase; error: Error };
}

export type TaskFlowPhase =
  | 'idle'
  | 'parsing'
  | 'analyzing'
  | 'generating'
  | 'executing'
  | 'reviewing'
  | 'completing'
  | 'done'
  | 'failed';

export type TaskFlowEventName = keyof TaskFlowEventMap;

export interface TaskFlowOptions {
  tracker: TaskTracker;
  events: EventBus;
  doneCondition?: DoneCondition | undefined;
  maxConcurrent?: number | undefined;
}

export interface TaskFlowExecutionContext {
  executeTask: (task: TaskNode) => Promise<unknown>;
  onTaskComplete?: (task: TaskNode | undefined, result: unknown) => void;
  onTaskFail?: (task: TaskNode | undefined, error: Error) => void;
}

export class TaskFlow {
  private phase: TaskFlowPhase = 'idle';
  private spec: Specification | null = null;
  private graph: TaskGraph | null = null;
  private stopped = false;

  constructor(private readonly opts: TaskFlowOptions) {
    this.setPhase('idle');
  }

  private emit<K extends TaskFlowEventName>(event: K, payload: TaskFlowEventMap[K]): void {
    (this.opts.events.emit as (event: string, payload: unknown) => void)(event, payload);
  }

  async fromSpec(specContent: string): Promise<TaskGraph> {
    this.setPhase('parsing');

    const parser = new SpecParser();
    this.spec = parser.parse(specContent);

    this.setPhase('analyzing');
    const analysis = parser.analyze(this.spec);
    this.emit('spec.analyzed', { analysis });

    if (analysis.completeness < 50) {
      const err = new SddError({
        message: `Spec completeness too low: ${analysis.completeness}%`,
        code: ERROR_CODES.SDD_VALIDATION_FAILED,
        context: { completeness: analysis.completeness },
      });
      this.emit('error', { phase: 'analyzing', error: err });
      this.setPhase('failed');
      throw err;
    }

    this.setPhase('generating');
    const generator = new TaskGenerator({
      taskTracker: this.opts.tracker,
      verificationFromAcceptance: process.env['WRONGSTACK_SDD_VERIFY_FROM_ACCEPTANCE'] === '1',
    });
    this.graph = await generator.generateFromSpec(this.spec);

    return this.graph;
  }

  async execute(ctx: TaskFlowExecutionContext): Promise<TaskGraph> {
    if (!this.graph)
      throw new SddError({
        message: 'No graph loaded. Call fromSpec first.',
        code: ERROR_CODES.SDD_INVALID_STATE,
        context: { phase: this.phase },
      });

    this.setPhase('executing');
    this.stopped = false;

    const pendingTasks = this.getExecutableTasks();
    const maxConcurrent = this.opts.maxConcurrent ?? 2;

    while (pendingTasks.length > 0 && !this.stopped) {
      const batch = pendingTasks.splice(0, maxConcurrent);
      const results = await Promise.allSettled(
        batch.map((task) => this.executeSingleTask(task, ctx)),
      );

      for (let i = 0; i < results.length; i++) {
        const result = expectDefined(results[i]);
        const task = expectDefined(batch[i]);

        if (result.status === 'rejected') {
          const reason = result.reason as Error | undefined;
          this.opts.tracker.updateNodeStatus(task.id, 'failed', reason?.message);
          this.emit('task.failed', { taskId: task.id, error: reason?.message ?? 'unknown' });
          ctx.onTaskFail?.(task, reason as Error);
        } else {
          this.opts.tracker.updateNodeStatus(task.id, 'completed');
          this.emit('task.completed', { taskId: task.id, result: result.value });
          ctx.onTaskComplete?.(task, result.value);
        }

        this.emitProgress();
      }

      // Re-evaluate pending tasks (some may have become unblocked)
      const stillPending = this.getExecutableTasks();
      pendingTasks.length = 0;
      pendingTasks.push(...stillPending);

      // Check done condition
      if (this.checkDoneCondition()) {
        break;
      }
    }

    this.setPhase('completing');
    this.emit('done', { graph: this.graph });
    this.setPhase('done');

    return this.graph;
  }

  async reviewTask(taskId: string, approved: boolean, comment?: string): Promise<void> {
    const task = this.opts.tracker.getNode(taskId);
    if (!task)
      throw new SddError({
        message: `Task ${taskId} not found`,
        code: ERROR_CODES.SDD_NOT_READY,
        context: { taskId },
      });

    if (approved) {
      this.opts.tracker.updateNodeStatus(taskId, 'completed', comment);
      this.emit('task.completed', { taskId });
    } else {
      this.opts.tracker.updateNodeStatus(taskId, 'in_progress', comment ?? 'Needs revision');
      this.emit('task.review', { taskId });
    }
  }

  stop(): void {
    this.stopped = true;
  }

  getPhase(): TaskFlowPhase {
    return this.phase;
  }

  getGraph(): TaskGraph | null {
    return this.graph;
  }

  getSpec(): Specification | null {
    return this.spec;
  }

  private setPhase(phase: TaskFlowPhase): void {
    const from = this.phase;
    this.phase = phase;
    this.emit('phase.change', { from, to: phase });
  }

  private getExecutableTasks(): TaskNode[] {
    return this.opts.tracker
      .getAllNodes({ status: ['pending', 'blocked'] })
      .filter((n) => n.status === 'pending' && this.opts.tracker.canStart(n.id))
      .sort((a, b) => {
        const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return priorityOrder[a.priority] - priorityOrder[b.priority];
      });
  }

  private async executeSingleTask(task: TaskNode, ctx: TaskFlowExecutionContext): Promise<unknown> {
    this.opts.tracker.updateNodeStatus(task.id, 'in_progress');
    this.emit('task.started', { taskId: task.id });
    return ctx.executeTask(task);
  }

  private checkDoneCondition(): boolean {
    const condition = this.opts.doneCondition;
    if (!condition) {
      const progress = this.opts.tracker.getProgress();
      return progress.percentComplete === 100;
    }

    switch (condition.type) {
      case 'all_tasks_done': {
        const progress = this.opts.tracker.getProgress();
        return progress.pending === 0 && progress.inProgress === 0;
      }
      case 'iterations':
        return false; // Not tracked here
      case 'tool_calls':
        return false;
      default:
        return false;
    }
  }

  private emitProgress(): void {
    const progress = this.opts.tracker.getProgress();
    this.emit('progress', {
      percent: progress.percentComplete,
      message: `${progress.completed}/${progress.total} tasks completed`,
    });
  }
}

export interface SpecDrivenDevOptions {
  workingDirectory: string;
  events: EventBus;
  doneCondition?: DoneCondition | undefined;
}

export class SpecDrivenDev {
  private store: DefaultTaskStore;
  private tracker: TaskTracker;
  private readonly events: EventBus;
  private flows = new Map<string, TaskFlow>();

  constructor(opts: SpecDrivenDevOptions) {
    this.store = new DefaultTaskStore();
    this.tracker = new TaskTracker({ store: this.store });
    this.events = opts.events;
  }

  async createFlow(specContent: string, options?: Partial<TaskFlowOptions>): Promise<TaskFlow> {
    const flow = new TaskFlow({
      tracker: this.tracker,
      events: this.events,
      ...options,
    });

    const graph = await flow.fromSpec(specContent);
    this.flows.set(graph.id, flow);

    return flow;
  }

  getTracker(): TaskTracker {
    return this.tracker;
  }

  getFlow(graphId: string): TaskFlow | undefined {
    return this.flows.get(graphId);
  }

  listFlows(): { id: string; title: string; phase: TaskFlowPhase }[] {
    return Array.from(this.flows.entries()).map(([id, flow]) => ({
      id,
      title: flow.getGraph()?.title ?? 'Untitled',
      phase: flow.getPhase(),
    }));
  }
}
