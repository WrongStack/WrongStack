import type {
  AgentMonitorService,
  DefaultMultiAgentCoordinator,
  Director,
  FleetManager,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { TaskResult } from '@wrongstack/core/types';

type CompletedTask = {
  id: string;
  subagentId?: string | undefined;
};

export function installDirectorTaskCompletedHandler(input: {
  director: Director;
  fleetManager?: FleetManager | undefined;
  agentMonitor?: AgentMonitorService | undefined;
  captureCompletedTaskLearning(result: TaskResult): void;
  isShadowTask(taskId: string): boolean;
  onShadowTaskCompleted(taskId: string, subagentId: string): void;
  emitLifecycleCompleted(taskId: string, result: TaskResult): void;
}): void {
  const {
    director,
    fleetManager,
    agentMonitor,
    captureCompletedTaskLearning,
    isShadowTask,
    onShadowTaskCompleted,
    emitLifecycleCompleted,
  } = input;

  director.on('task.completed', ({ task, result }) => {
    const completedTask = task as CompletedTask;
    const taskResult = result as TaskResult;
    fleetManager?.removePendingTask(completedTask.id);
    captureCompletedTaskLearning(taskResult);
    if (isShadowTask(completedTask.id)) {
      onShadowTaskCompleted(completedTask.id, taskResult.subagentId);
      return;
    }
    emitLifecycleCompleted(completedTask.id, taskResult);
    if (agentMonitor) {
      const subagentId = completedTask.subagentId ?? completedTask.id;
      const status =
        taskResult.status === 'success'
          ? ('completed' as const)
          : taskResult.status === 'timeout'
            ? ('timeout' as const)
            : taskResult.status === 'stopped'
              ? ('stopped' as const)
              : ('failed' as const);
      const summary =
        taskResult.status === 'success'
          ? `Completed in ${taskResult.iterations} iterations`
          : (taskResult.error?.message ?? taskResult.status);
      agentMonitor.completeSubagent(subagentId, status, summary);
    }
  });
}

export function registerDirectorBudgetAndContextBridges(input: {
  director: Director;
  events: EventBus;
  /**
   * The session that OWNS the subagent an event is about — not the host's own.
   * With four tabs on one host these differ: the host session names the tab it
   * booted with, so a worker delegated from a background tab announced its
   * budget and context pressure into the boot tab's panels and vanished from
   * the tab that was actually waiting on it.
   */
  sessionFor: (subagentId: string) => string;
}): Array<() => void> {
  const { director, events, sessionFor } = input;

  return [
    director.fleet.filter('budget.threshold_reached', (e) => {
      const payload = e.payload as { kind: string; used: number; limit: number };
      events.emit('subagent.budget_warning', {
        sessionId: sessionFor(e.subagentId),
        subagentId: e.subagentId,
        kind: payload.kind,
        used: payload.used,
        limit: payload.limit,
      });
    }),
    director.fleet.filter('budget.extended', (e) => {
      const payload = e.payload as { kind: string; newLimit: number; totalExtensions: number };
      events.emit('subagent.budget_extended', {
        sessionId: sessionFor(e.subagentId),
        subagentId: e.subagentId,
        kind: payload.kind,
        newLimit: payload.newLimit,
        totalExtensions: payload.totalExtensions,
      });
    }),
    director.fleet.filter('ctx.pct', (e) => {
      const payload = e.payload as { load: number; tokens: number; maxContext: number };
      events.emit('subagent.ctx_pct', {
        sessionId: sessionFor(e.subagentId),
        subagentId: e.subagentId,
        load: payload.load,
        tokens: payload.tokens,
        maxContext: payload.maxContext,
      });
    }),
  ];
}

/**
 * `coordinator.stats` — fleet-wide on purpose.
 *
 * Unlike the lifecycle bridges beside it, this one is NOT split per
 * conversation, and the stamp is the host's own session rather than any
 * worker's owner. Everything it reports is a property of the fleet as a
 * whole: the spawn and concurrency budget is one ceiling shared by every tab,
 * and the status list is the coordinator's own roll-up. Splitting it would
 * mean reporting a shared budget four times as if each tab had its own.
 *
 * The client stores it in `useCoordinatorMonitorStore`, which has no live UI
 * consumer. If one is ever added it must filter `subagentStatuses` by owner
 * (`coordinator.sessionOf`) rather than assume the frame describes the tab it
 * arrived in.
 */
export function registerDirectorStatsBridge(input: {
  director: Director;
  events: EventBus;
  /** Host session — the fleet's own address, not any worker's owner. */
  sessionId: string;
}): () => void {
  const { director, events, sessionId } = input;

  return director.fleet.filter('coordinator.stats', (e) => {
    const payload = e.payload as {
      total: number;
      running: number;
      idle: number;
      stopped: number;
      inFlight: number;
      pending: number;
      completed: number;
      subagentStatuses: {
        subagentId: string;
        taskId: string;
        status: string;
        assigned: boolean;
      }[];
    };
    let usage: { total?: { cost?: number }; perSubagent?: Record<string, unknown> } | null = null;
    try {
      usage = director.snapshot();
    } catch {
      usage = null;
    }
    const perSubagent = usage?.perSubagent ?? {};
    const subagentStatuses = payload.subagentStatuses.map((s) => {
      const u = perSubagent[s.subagentId] as
        | {
            model?: string | undefined;
            cost?: number | undefined;
            startedAt?: number | undefined;
            lastEventAt?: number | undefined;
            iterations?: number | undefined;
            toolCalls?: number | undefined;
          }
        | undefined;
      if (u === undefined) return s;
      return {
        ...s,
        ...(u.model !== undefined ? { model: u.model } : {}),
        ...(u.cost !== undefined ? { costUsd: u.cost } : {}),
        ...(u.startedAt !== undefined ? { runtimeMs: Date.now() - u.startedAt } : {}),
        ...(u.lastEventAt !== undefined
          ? { lastActivityAt: new Date(u.lastEventAt).toISOString() }
          : {}),
        ...(u.iterations !== undefined ? { iterations: u.iterations } : {}),
        ...(u.toolCalls !== undefined ? { toolCalls: u.toolCalls } : {}),
      };
    });
    // Lifetime spawn budget for HQ + WebUI (issue #323).
    const budgetSnap = director.fleetManager?.budgetSnapshot?.();
    const maxSpawns = budgetSnap?.maxSpawns ?? director.maxSpawns;
    const usedSpawns = budgetSnap?.usedSpawns ?? director.spawnCount;
    const remainingSpawns =
      budgetSnap?.remainingSpawns ??
      Math.max(0, (Number.isFinite(maxSpawns) ? maxSpawns : Number.POSITIVE_INFINITY) - usedSpawns);

    events.emit('coordinator.stats', {
      sessionId,
      total: payload.total,
      running: payload.running,
      idle: payload.idle,
      stopped: payload.stopped,
      inFlight: payload.inFlight,
      pending: payload.pending,
      completed: payload.completed,
      ...(usage?.total?.cost !== undefined ? { totalCostUsd: usage.total.cost } : {}),
      maxSpawns,
      usedSpawns,
      remainingSpawns,
      ...(budgetSnap?.checkpointMaxSpawns !== undefined
        ? { checkpointMaxSpawns: budgetSnap.checkpointMaxSpawns }
        : {}),
      ...(budgetSnap?.ceilingMismatch ? { ceilingMismatch: true } : {}),
      subagentStatuses,
    });
  });
}

export function registerDirectorSubagentLifecycleBridges(input: {
  director: Director;
  events: EventBus;
  /** Owning session of the subagent — see `registerDirectorBudgetAndContextBridges`. */
  sessionFor: (subagentId: string) => string;
  agentMonitor?: AgentMonitorService | undefined;
  onSubagentRemoved(subagentId: string): void;
}): Array<() => void> {
  const { director, events, sessionFor, agentMonitor, onSubagentRemoved } = input;

  return [
    director.fleet.filter('subagent.spawned', (e) => {
      const payload = e.payload as {
        subagentId: string;
        taskId: string;
        name?: string | undefined;
        role?: string | undefined;
        provider?: string | undefined;
        model?: string | undefined;
      };
      events.emit('subagent.spawned', {
        sessionId: sessionFor(payload.subagentId),
        subagentId: payload.subagentId,
        taskId: payload.taskId,
        name: payload.name,
        provider: payload.provider,
        model: payload.model,
      });
      if (agentMonitor) {
        const agentName = payload.name ?? payload.role ?? payload.subagentId;
        agentMonitor.trackSubagent(payload.subagentId, agentName, payload.taskId);
      }
    }),
    director.fleet.filter('subagent.removed', (e) => {
      const payload = e.payload as {
        subagentId?: string | undefined;
        reason?: string | undefined;
      };
      const subagentId = payload.subagentId ?? e.subagentId;
      const removedSessionId = sessionFor(subagentId);
      onSubagentRemoved(subagentId);
      agentMonitor?.removeSubagent(subagentId);
      // Resolve BEFORE the coordinator forgets the worker: `onSubagentRemoved`
      // above is the host's own bookkeeping, but a later lookup would fall
      // back to the host session and file the removal in the wrong roster.
      events.emit('subagent.removed', {
        sessionId: removedSessionId,
        subagentId,
        reason: payload.reason ?? 'subagent lifecycle completed',
      });
    }),
  ];
}

export function registerCoordinatorLifecycleHandlers(input: {
  coordinator: DefaultMultiAgentCoordinator;
  events: EventBus;
  /** Owning session of the subagent — see `registerDirectorBudgetAndContextBridges`. */
  sessionFor: (subagentId: string) => string;
  isShadowTask(taskId: string): boolean;
  onSubagentStopped(subagentId: string): void;
}): () => void {
  const { coordinator, events, sessionFor, isShadowTask, onSubagentStopped } = input;
  const taskAssignedHandler = ({
    task,
    subagentId,
  }: {
    task: { id: string; description?: string | undefined };
    subagentId: string;
  }) => {
    if (isShadowTask(task.id)) return;
    events.emit('subagent.task_started', {
      sessionId: sessionFor(subagentId),
      subagentId,
      taskId: task.id,
      description: task.description,
    });
  };
  const subagentStoppedHandler = ({ subagentId }: { subagentId: string }) => {
    onSubagentStopped(subagentId);
  };
  coordinator.on('task.assigned', taskAssignedHandler);
  coordinator.on('subagent.stopped', subagentStoppedHandler);
  return () => {
    coordinator.off('task.assigned', taskAssignedHandler);
    coordinator.off('subagent.stopped', subagentStoppedHandler);
  };
}
