import type { Logger } from '@wrongstack/contracts/types';
import { type GoalRunState, type PhaseGraph, transitionGoalRun } from '@wrongstack/goal';

/** The host-side run status broadcast to clients (`idle` = no run). */
export type GoalRunStatus = 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped';

interface GoalRunStateHost {
  runStatus: GoalRunStatus;
  readonly logger: Logger;
}

/** Move a graph's persisted run state through the shared lifecycle table. */
export function moveGoalRun(
  host: Pick<GoalRunStateHost, 'logger'>,
  graph: PhaseGraph,
  next: GoalRunState | undefined,
): boolean {
  return transitionGoalRun(graph, next, (message) => host.logger.warn(`[Goal] ${message}`));
}

/**
 * Move the run's graph and the host status together. When the lifecycle table
 * refuses the graph edge (e.g. a pause after the run completed) neither
 * changes, so the broadcast status never contradicts the persisted state.
 */
export function setGoalRunState(
  host: GoalRunStateHost,
  graph: PhaseGraph,
  next: Exclude<GoalRunState, 'planning'>,
): boolean {
  if (!moveGoalRun(host, graph, next)) return false;
  host.runStatus = next;
  return true;
}
