import type { EventBus } from '@wrongstack/contracts/kernel';
import type { FleetBudget } from '@wrongstack/coordination';

/**
 * The fleet gauge every host shows: workers running against the concurrency ceiling, and spawns
 * used against the spawn budget (issue #323). Shared by the CLI-hosted WebUI and the standalone
 * engine (desktop) so both send the same `fleet.concurrency_update` frame.
 */

export interface FleetConcurrencyFrames {
  /** Sends the current gauge now (a host calls it when a client (re)connects). */
  emit(): void;
  dispose(): void;
}

/**
 * Sends `fleet.concurrency_update` now and whenever the concurrency ceiling changes or a worker
 * starts or finishes. Without a director budget it counts spawned and completed workers itself.
 *
 * The frame is deliberately UNSTAMPED: the budget is one ceiling for the whole process, which
 * every tab draws from and the client keeps in one global store. Stamping it with a conversation
 * made a page that did not declare that conversation drop it, freezing the gauge.
 */
export function installFleetConcurrencyFrames(deps: {
  events: Pick<EventBus, 'on'>;
  broadcast: (message: {
    type: 'fleet.concurrency_update';
    payload: Record<string, unknown>;
  }) => void;
  getBudget?: (() => FleetBudget | null) | undefined;
}): FleetConcurrencyFrames {
  let active = 0;
  let ceiling = 4;
  const emit = (): void => {
    const budget = deps.getBudget?.() ?? null;
    deps.broadcast({
      type: 'fleet.concurrency_update',
      payload: {
        fleetConcurrency: budget?.activeAgents ?? active,
        fleetConcurrencyMax: budget?.maxConcurrent ?? ceiling,
        ...(budget
          ? {
              maxSpawns: budget.maxSpawns,
              usedSpawns: budget.usedSpawns,
              remainingSpawns: budget.remainingSpawns,
              maxSpawnsSource: budget.maxSpawnsSource,
              maxConcurrentSource: budget.maxConcurrentSource,
              effectiveSource: budget.effectiveSource,
              checkpointMaxSpawns: budget.checkpointMaxSpawns,
              ceilingMismatch: budget.ceilingMismatch,
            }
          : {}),
      },
    });
  };
  emit();
  const off = [
    deps.events.on('concurrency.changed', (event) => {
      ceiling = Math.max(1, event.n);
      emit();
    }),
    deps.events.on('subagent.spawned', () => {
      active += 1;
      emit();
    }),
    deps.events.on('subagent.task_completed', () => {
      active = Math.max(0, active - 1);
      emit();
    }),
  ];
  return {
    emit,
    dispose: () => {
      for (const unsubscribe of off) unsubscribe();
    },
  };
}
