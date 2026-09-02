import { PhaseGraphBuilder } from './phase-graph-builder.js';
import { PhaseOrchestrator } from './phase-orchestrator.js';
import type {
  GoalOptions,
  PhaseExecutionContext,
  PhaseGraph,
  PhaseNode,
  PhaseProgress,
  PhaseTemplate,
} from './types.js';

export interface GoalRunnerOptions extends GoalOptions {
  /** Project title. */
  title: string;
  description?: string | undefined;
  /** Phase templates. */
  phases: PhaseTemplate[];
  /** Function that executes a task. */
  executeTask: PhaseExecutionContext['executeTask'];
  /** Optional verification gate. */
  verifyPhase?: PhaseExecutionContext['verifyPhase'] | undefined;
  /** Optional repair pass after verification failure. */
  repairPhase?: PhaseExecutionContext['repairPhase'] | undefined;
  /** Optional resolver for worktree merge conflicts. */
  resolveConflict?: PhaseExecutionContext['resolveConflict'] | undefined;
  /** Optional Brain arbiter. */
  brain?: PhaseExecutionContext['brain'] | undefined;
  /** Called when a phase completes. */
  onPhaseComplete?: ((phase: PhaseNode) => void) | undefined;
  /** Called when a phase fails. */
  onPhaseFail?: (phase: PhaseNode, error: Error) => void;
  /** Called on every orchestrator tick. */
  onTick?: (ctx: { activePhases: PhaseNode[]; readyPhases: PhaseNode[] }) => void;
  /** Called when progress changes. */
  onProgress?: ((progress: PhaseProgress) => void) | undefined;
  /** Safety net that stops a phase graph if cleanup is bypassed. Default: 24h. */
  maxRunDurationMs?: number | undefined;
  /** Called when the graph completes. */
  onComplete?: ((graph: PhaseGraph) => void) | undefined;
  /** Called when the graph fails. */
  onFail?: (graph: PhaseGraph, failedPhase: PhaseNode, error: Error) => void;
}

/**
 * GoalRunner - high-level API for managing the whole autonomous phase flow from one entry point.
 *
 * Usage:
 *   const runner = new GoalRunner({
 *     title: 'Auth Refactor',
 *     phases: [...],
 *     executeTask: async (task, phaseId) => { ... },
 *     onProgress: (p) => console.log(`${p.percentComplete}% done`),
 *   });
 *   await runner.start();
 */
export class GoalRunner {
  private graph: PhaseGraph | null = null;
  private orchestrator: PhaseOrchestrator | null = null;
  private opts: GoalRunnerOptions;
  private progressInterval: ReturnType<typeof setInterval> | null = null;
  private maxRunTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly graphCompletedHandler = (payload: unknown) => {
    const p = payload as { graphId: string; durationMs: number };
    if (this.graph && p.graphId === this.graph.id) {
      this.opts.onComplete?.(this.graph);
      this.cleanup();
    }
  };

  private readonly graphFailedHandler = (payload: unknown) => {
    const p = payload as { graphId: string; failedPhaseId: string; error: string };
    if (this.graph && p.graphId === this.graph.id) {
      const failedPhase = this.graph.phases.get(p.failedPhaseId);
      if (failedPhase) {
        this.opts.onFail?.(this.graph, failedPhase, new Error(p.error));
      }
      // Only cleanup on failure when stopOnFailure is explicitly true.
      // When false (default), the orchestrator continues with remaining phases.
      if (this.opts.stopOnFailure) {
        this.cleanup();
      }
    }
  };

  /** Stores the unsubscribe function returned by EventBus.on() */
  private unsubscribeCompleted: (() => void) | null = null;
  private unsubscribeFailed: (() => void) | null = null;

  constructor(opts: GoalRunnerOptions) {
    this.opts = opts;
  }

  async start(): Promise<PhaseGraph> {
    // Create the phase graph.
    const builder = new PhaseGraphBuilder({
      title: this.opts.title,
      description: this.opts.description,
      phases: this.opts.phases,
      autonomous: this.opts.autonomous,
      stopOnFailure: this.opts.stopOnFailure,
    });

    this.graph = await builder.build();

    // Execution context
    const ctx: PhaseExecutionContext = {
      executeTask: this.opts.executeTask,
      brain: this.opts.brain,
      onPhaseComplete: (phase) => {
        this.opts.onPhaseComplete?.(phase);
      },
      onPhaseFail: (phase, error) => {
        this.opts.onPhaseFail?.(phase, error);
      },
      onTick: (tickCtx) => {
        this.opts.onTick?.(tickCtx);
      },
    };
    if (this.opts.verifyPhase !== undefined) ctx.verifyPhase = this.opts.verifyPhase;
    if (this.opts.repairPhase !== undefined) ctx.repairPhase = this.opts.repairPhase;
    if (this.opts.resolveConflict !== undefined) ctx.resolveConflict = this.opts.resolveConflict;

    // Create and start the orchestrator.
    this.orchestrator = new PhaseOrchestrator({
      graph: this.graph,
      ctx,
      maxConcurrentPhases: this.opts.maxConcurrentPhases,
      maxConcurrentTasks: this.opts.maxConcurrentTasks,
      maxRetries: this.opts.maxRetries,
      maxVerifyAttempts: this.opts.maxVerifyAttempts,
      autonomous: this.opts.autonomous,
      phaseDelayMs: this.opts.phaseDelayMs,
      stopOnFailure: this.opts.stopOnFailure,
      events: this.opts.events,
      worktrees: this.opts.worktrees,
    });

    // Register event listeners using the untyped surface to handle custom events.
    // Call through the bus as the receiver — detaching the method (`const f =
    // events.on`) loses `this`, and EventBus.on is a plain prototype method, so
    // the detached call throws on `this.listeners`. The arrow wrapper keeps it
    // bound to the bus.
    if (this.opts.events) {
      const bus = this.opts.events as unknown as {
        on(event: string, handler: (payload: unknown) => void): () => void;
      };
      const onUntyped = (event: string, handler: (payload: unknown) => void): (() => void) =>
        bus.on(event, handler);
      // Store the unsubscribe functions for proper cleanup
      this.unsubscribeCompleted = onUntyped('graph.completed', this.graphCompletedHandler);
      this.unsubscribeFailed = onUntyped('graph.failed', this.graphFailedHandler);
    }

    await this.orchestrator.start();

    // Arm the max-run-duration timeout only AFTER orchestrator.start() settles,
    // so the timer cannot fire mid-start and race with this.orchestrator.stop().
    this.maxRunTimer = setTimeout(
      () => {
        this.opts.onProgress?.({
          totalPhases: 0,
          pending: 0,
          ready: 0,
          running: 0,
          paused: 0,
          completed: 0,
          failed: 0,
          skipped: 0,
          percentComplete: 0,
          totalTasks: 0,
          completedTasks: 0,
          failedTasks: 0,
          estimatedHours: 0,
          actualHours: 0,
        });
        this.stop();
      },
      this.opts.maxRunDurationMs ?? 7 * 24 * 60 * 60_000,
    );
    if (this.opts.maxRunDurationMs !== undefined && this.opts.maxRunDurationMs <= 0) {
      clearTimeout(this.maxRunTimer);
      this.maxRunTimer = null;
    }
    this.maxRunTimer?.unref?.();

    // Progress reporting — start after orchestrator is running.
    if (this.opts.onProgress) {
      this.progressInterval = setInterval(() => {
        const progress = this.orchestrator?.getProgress();
        if (progress) this.opts.onProgress?.(progress);
      }, 2000);
    }

    return this.graph;
  }

  pause(): void {
    this.orchestrator?.pause();
  }

  resume(): void {
    this.orchestrator?.resume();
  }

  stop(): void {
    this.orchestrator?.stop();
    this.cleanup();
  }

  getProgress(): PhaseProgress | null {
    return this.orchestrator?.getProgress() ?? null;
  }

  getGraph(): PhaseGraph | null {
    return this.graph;
  }

  isRunning(): boolean {
    return this.orchestrator?.isRunning() ?? false;
  }

  isPaused(): boolean {
    return this.orchestrator?.isPaused() ?? false;
  }

  assignAgent(phaseId: string, agentId: string): void {
    this.orchestrator?.assignAgent(phaseId, agentId);
  }

  releaseAgent(phaseId: string, agentId: string): void {
    this.orchestrator?.releaseAgent(phaseId, agentId);
  }

  private cleanup(): void {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    if (this.maxRunTimer) {
      clearTimeout(this.maxRunTimer);
      this.maxRunTimer = null;
    }
    // Use the unsubscribe functions returned by EventBus.on() instead of .off()
    this.unsubscribeCompleted?.();
    this.unsubscribeCompleted = null;
    this.unsubscribeFailed?.();
    this.unsubscribeFailed = null;
  }
}

/**
 * Quick-start helper: create an GoalRunner from an existing TaskGraph.
 */
export async function createGoalRunnerFromTaskGraph(
  taskGraph: import('../types/task-graph.js').TaskGraph,
  options: Omit<GoalRunnerOptions, 'phases' | 'title'> & {
    title?: string | undefined;
    tasksPerPhase?: number | undefined;
  },
): Promise<GoalRunner> {
  const graph = await PhaseGraphBuilder.fromTaskGraph(taskGraph, {
    title: options.title ?? taskGraph.title,
    tasksPerPhase: options.tasksPerPhase,
  });

  // Extract phase templates from the PhaseGraph.
  const phases: PhaseTemplate[] = Array.from(graph.phases.values()).map((p) => ({
    name: p.name,
    description: p.description,
    priority: p.priority,
    estimateHours: p.estimateHours,
    parallelizable: p.parallelizable,
  }));

  return new GoalRunner({
    ...options,
    title: options.title ?? taskGraph.title,
    phases,
  });
}
