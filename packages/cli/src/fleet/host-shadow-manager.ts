/**
 * Host-level Shadow Agent lifecycle and observation management.
 *
 * @module fleet/host-shadow-manager
 */

import type { Config, SubagentConfig } from '@wrongstack/core/types';
import type { Director } from '@wrongstack/core/coordination';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';
import { runHostShadowPass, stopHostShadowAfterTask } from './host-shadow-pass.js';

export interface HostShadowManagerContext {
  deps: MultiAgentDeps;
  opts: MultiAgentHostOptions;
  getDirector: () => Director | undefined;
  spawnAndAssign: (
    subagentConfig: SubagentConfig,
    description: string,
    opts?: {
      internalTask?: boolean;
      stopShadowAfterTask?: boolean;
      shadowIntervalMs?: number | undefined;
      taskContext?: {
        kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
      } | undefined;
    },
  ) => Promise<{ subagentId: string; taskId: string }>;
}

export class HostShadowManager {
  private shadowAgentId: string | null = null;
  private shadowTaskId: string | null = null;
  private readonly shadowTaskIds = new Set<string>();
  private readonly shadowOutstandingTaskIds = new Set<string>();
  private readonly shadowStopAfterTaskIds = new Set<string>();
  private shadowHeartbeatIntervalMs = 30_000;
  private shadowAutoStartSuppressions = 0;
  private shadowObservedWorkDepth = 0;
  private shadowPassInFlight = false;
  private shadowQueuedProblem: string | null = null;
  private readonly shadowActivityOffHandles: Array<() => void> = [];

  constructor(private readonly ctx: HostShadowManagerContext) {}

  getTaskIds(): ReadonlySet<string> {
    return this.shadowTaskIds;
  }

  isShadowTask(taskId: string): boolean {
    return this.shadowTaskIds.has(taskId);
  }

  getAgentId(): string | null {
    return this.shadowAgentId;
  }

  getTaskId(): string | null {
    return this.shadowTaskId;
  }

  enterShadowSpawn(): void {
    this.shadowAutoStartSuppressions++;
  }

  exitShadowSpawn(): void {
    this.shadowAutoStartSuppressions--;
  }

  onShadowTaskCompleted(taskId: string, subagentId: string): void {
    this.shadowOutstandingTaskIds.delete(taskId);
    if (this.shadowStopAfterTaskIds.delete(taskId)) {
      void this.stopShadowAfterTask(subagentId);
    }
  }

  armIfNeeded(): void {
    if (this.shadowActivityOffHandles.length > 0) return;

    this.shadowActivityOffHandles.push(
      this.ctx.deps.events.on('agent.run.started', () => this.noteShadowWorkStarted()),
      this.ctx.deps.events.on('agent.run.completed', (e) => {
        const problem =
          e.status === 'failed' || e.status === 'max_iterations'
            ? `leader run ended with ${e.status}`
            : undefined;
        this.noteShadowWorkCompleted(problem);
      }),
      this.ctx.deps.events.on('subagent.task_started', () => this.noteShadowWorkStarted()),
      this.ctx.deps.events.on('subagent.task_completed', (e) => {
        const problem =
          e.status === 'failed' || e.status === 'timeout'
            ? `subagent ${e.subagentId} task ${e.taskId} ended with ${e.status}${e.error?.message ? `: ${e.error.message}` : ''}`
            : undefined;
        this.noteShadowWorkCompleted(problem);
      }),
    );
  }

  recordShadowAgent(
    subagentId: string,
    taskId: string,
    intervalMs = this.shadowHeartbeatIntervalMs,
  ): void {
    this.shadowAgentId = subagentId;
    this.shadowTaskId = taskId;
    this.shadowHeartbeatIntervalMs = intervalMs;
    this.markShadowTask(taskId);
    this.ctx.opts.onShadowAgentStarted?.(subagentId);
  }

  clearShadowAgent(subagentId?: string): void {
    if (subagentId && this.shadowAgentId !== subagentId) return;
    const stoppedId = this.shadowAgentId;
    this.shadowAgentId = null;
    this.shadowTaskId = null;
    this.shadowOutstandingTaskIds.clear();
    this.shadowStopAfterTaskIds.clear();
    if (stoppedId) this.ctx.opts.onShadowAgentStopped?.(stoppedId);
  }

  markShadowTask(taskId: string): void {
    this.shadowTaskIds.add(taskId);
    this.shadowOutstandingTaskIds.add(taskId);
  }

  addStopAfterTaskId(taskId: string): void {
    this.shadowStopAfterTaskIds.add(taskId);
  }

  removeShadowTask(taskId: string): void {
    this.shadowTaskIds.delete(taskId);
    this.shadowOutstandingTaskIds.delete(taskId);
    this.shadowStopAfterTaskIds.delete(taskId);
  }

  isActiveSubagent(subagentId: string): boolean {
    const director = this.ctx.getDirector();
    if (!director) return false;
    const coordinator = (director as never as { coordinator: { getStatus: () => { subagents: Array<{ id: string; status: string }> } } }).coordinator;
    const status = coordinator
      .getStatus()
      .subagents.find((a) => a.id === subagentId)?.status;
    return status === 'running' || status === 'idle';
  }

  private noteShadowWorkStarted(): void {
    if (this.shadowAutoStartSuppressions > 0) return;
    this.shadowObservedWorkDepth++;
  }

  private noteShadowWorkCompleted(problem?: string | undefined): void {
    if (problem) {
      this.shadowQueuedProblem = this.shadowQueuedProblem
        ? `${this.shadowQueuedProblem}; ${problem}`
        : problem;
    }
    if (this.shadowObservedWorkDepth > 0) {
      this.shadowObservedWorkDepth--;
    }
    if (this.shadowObservedWorkDepth === 0 && this.shadowQueuedProblem) {
      const queued = this.shadowQueuedProblem;
      this.shadowQueuedProblem = null;
      this.requestShadowPass(queued);
    }
  }

  requestShadowPass(reason: string): void {
    const director = this.ctx.getDirector();
    if (!director) return;
    if (this.shadowObservedWorkDepth > 0) {
      this.shadowQueuedProblem = this.shadowQueuedProblem
        ? `${this.shadowQueuedProblem}; ${reason}`
        : reason;
      return;
    }
    if (
      this.shadowPassInFlight ||
      (this.shadowAgentId && this.isActiveSubagent(this.shadowAgentId))
    ) {
      this.shadowQueuedProblem = this.shadowQueuedProblem
        ? `${this.shadowQueuedProblem}; ${reason}`
        : reason;
      return;
    }

    this.shadowPassInFlight = true;
    queueMicrotask(() => {
      void this.runShadowPass(reason);
    });
  }

  private async runShadowPass(reason: string): Promise<void> {
    return runHostShadowPass(
      {
        getDirector: () => this.ctx.getDirector(),
        getLiveConfig: () => this.ctx.deps.configStore.get() as Config,
        getObservedWorkDepth: () => this.shadowObservedWorkDepth,
        getQueuedProblem: () => this.shadowQueuedProblem,
        setQueuedProblem: (value) => {
          this.shadowQueuedProblem = value;
        },
        setPassInFlight: (value) => {
          this.shadowPassInFlight = value;
        },
        getHeartbeatIntervalMs: () => this.shadowHeartbeatIntervalMs,
        spawnAndAssign: (subagentConfig, task, opts) =>
          this.ctx.spawnAndAssign(subagentConfig, task, opts),
        requestShadowPass: (queued) => this.requestShadowPass(queued),
      },
      reason,
    );
  }

  private async stopShadowAfterTask(subagentId: string): Promise<void> {
    const director = this.ctx.getDirector();
    const coordinator = director ? (director as never as { coordinator: { stop: (id: string) => Promise<void> } }).coordinator : undefined;
    return stopHostShadowAfterTask(
      (targetSubagentId) => coordinator?.stop(targetSubagentId) ?? Promise.resolve(),
      (targetSubagentId) => this.clearShadowAgent(targetSubagentId),
      () => this.shadowObservedWorkDepth,
      () => this.shadowQueuedProblem,
      (value) => {
        this.shadowQueuedProblem = value;
      },
      (queued) => this.requestShadowPass(queued),
      subagentId,
    );
  }

  dispose(): void {
    this.clearShadowAgent();
    for (const off of this.shadowActivityOffHandles) {
      off();
    }
    this.shadowActivityOffHandles.length = 0;
  }
}
