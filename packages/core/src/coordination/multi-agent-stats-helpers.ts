import type { CoordinatorStatus } from '../types/multi-agent.js';
import type { FleetBus } from './fleet-bus.js';
import type { SubagentEntry } from './multi-agent-queue-helpers.js';

export interface CoordinatorStatsSnapshot {
  total: number;
  running: number;
  idle: number;
  stopped: number;
  inFlight: number;
  pending: number;
  completed: number;
}

export function computeCoordinatorStats(
  subagents: Map<string, SubagentEntry>,
  inFlight: number,
  pendingCount: number,
  completedCount: number,
): CoordinatorStatsSnapshot {
  let running = 0;
  let idle = 0;
  let stopped = 0;
  for (const [, entry] of subagents) {
    if (entry.status === 'running') running++;
    else if (entry.status === 'idle') idle++;
    else stopped++;
  }
  return {
    total: subagents.size,
    running,
    idle,
    stopped,
    inFlight,
    pending: pendingCount,
    completed: completedCount,
  };
}

export function emitCoordinatorStatsEvent(params: {
  fleetBus?: FleetBus | undefined;
  coordinatorId: string;
  subagents: Map<string, SubagentEntry>;
  inFlight: number;
  pendingCount: number;
  completedCount: number;
  currentSessionId: () => string;
}): void {
  const {
    fleetBus,
    coordinatorId,
    subagents,
    inFlight,
    pendingCount,
    completedCount,
    currentSessionId,
  } = params;

  const sessionId = currentSessionId();
  if (!fleetBus) return;

  const stats = computeCoordinatorStats(subagents, inFlight, pendingCount, completedCount);
  const subagentStatuses = Array.from(subagents.entries()).map(([id, s]) => ({
    subagentId: id,
    taskId: s.currentTask ?? '',
    status: s.status,
    assigned: s.context.parentBridge !== null,
    sessionId: s.sessionId,
  }));

  fleetBus.emit({
    subagentId: coordinatorId,
    ts: Date.now(),
    type: 'coordinator.stats',
    payload: {
      sessionId,
      ...stats,
      subagentStatuses,
    },
  });
}

export function buildCoordinatorStatus(params: {
  coordinatorId: string;
  subagents: Map<string, SubagentEntry>;
  pendingCount: number;
  completedCount: number;
  totalIterations: number;
  isDone: boolean;
}): CoordinatorStatus {
  const { coordinatorId, subagents, pendingCount, completedCount, totalIterations, isDone } =
    params;

  return {
    coordinatorId,
    subagents: Array.from(subagents.entries()).map(([id, s]) => ({
      id,
      name: s.config.name,
      status: s.status,
      currentTask: s.currentTask,
    })),
    pendingTasks: pendingCount,
    completedTasks: completedCount,
    totalIterations,
    done: isDone,
  };
}
