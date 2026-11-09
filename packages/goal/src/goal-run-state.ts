import type { PhaseGraph } from './types.js';

export type GoalRunState = NonNullable<PhaseGraph['runState']>;

/** `undefined` is a graph that never ran, or one a retry reopened. */
type GoalRunSlot = GoalRunState | 'unset';

/**
 * The persisted Goal run lifecycle, shared by the CLI and WebUI hosts. Every
 * host write of `graph.runState` goes through `transitionGoalRun`, which
 * refuses an edge missing here.
 *
 * Edges worth knowing:
 * - `completed` only reopens (→ unset) through a board retry. A pause,
 *   resume, stop or late failure that lands after completion is refused —
 *   that is what used to persist finished Goals as paused/running/stopped.
 *   It also keeps a later run's planner error from overwriting a previous,
 *   completed graph.
 * - `failed` → running/paused: a checkpoint restore with no failed phase left.
 * - stopped/paused/running → running: resuming a saved or interrupted board.
 */
const ALLOWED: Readonly<Record<GoalRunSlot, readonly GoalRunSlot[]>> = {
  unset: ['planning', 'running', 'stopped', 'failed'],
  planning: ['stopped', 'failed'],
  running: ['paused', 'stopped', 'completed', 'failed'],
  paused: ['running', 'stopped', 'completed', 'failed'],
  stopped: ['running'],
  completed: ['unset'],
  failed: ['unset', 'running', 'paused'],
};

export function canTransitionGoalRun(
  from: GoalRunState | undefined,
  to: GoalRunState | undefined,
): boolean {
  if (from === to) return true;
  const fromSlot: GoalRunSlot = from ?? 'unset';
  const toSlot: GoalRunSlot = to ?? 'unset';
  return Object.hasOwn(ALLOWED, fromSlot) && ALLOWED[fromSlot].includes(toSlot);
}

/**
 * Move `graph.runState` along the lifecycle. An undeclared edge is refused and
 * reported through `onRefused` instead of applied. Returns whether the graph
 * is now in `next`.
 */
export function transitionGoalRun(
  graph: Pick<PhaseGraph, 'id' | 'runState'>,
  next: GoalRunState | undefined,
  onRefused?: (message: string) => void,
): boolean {
  if (!canTransitionGoalRun(graph.runState, next)) {
    onRefused?.(
      `Goal ${graph.id} refused run state ${graph.runState ?? 'unset'} -> ${next ?? 'unset'}`,
    );
    return false;
  }
  graph.runState = next;
  return true;
}
