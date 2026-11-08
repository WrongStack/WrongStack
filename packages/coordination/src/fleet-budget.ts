/**
 * A fleet director's spawn and concurrency budget as the hosts' fleet gauge shows it (issue #323):
 * workers running, spawns used against the spawn budget. The CLI-hosted WebUI and the standalone
 * engine both read it here.
 */

/** What a fleet director exposes for the gauge; the coordination `Director` satisfies it. */
export interface FleetBudgetDirector {
  readonly maxSpawns: number;
  readonly spawnCount: number;
  status(): { subagents: ReadonlyArray<{ status: string }> };
  readonly fleetManager?:
    | {
        budgetSnapshot?: () =>
          | {
              maxSpawns: number;
              usedSpawns: number;
              remainingSpawns: number;
              checkpointMaxSpawns?: number | undefined;
              ceilingMismatch?: boolean | undefined;
            }
          | undefined;
      }
    | undefined;
}

export interface FleetBudget {
  maxSpawns?: number | undefined;
  usedSpawns?: number | undefined;
  remainingSpawns?: number | undefined;
  maxConcurrent?: number | undefined;
  activeAgents?: number | undefined;
  maxSpawnsSource?: string | undefined;
  maxConcurrentSource?: string | undefined;
  effectiveSource?: string | undefined;
  checkpointMaxSpawns?: number | undefined;
  ceilingMismatch?: boolean | undefined;
}

/** The live budget of a director, or null before the fleet has one. */
export function fleetBudgetFromDirector(
  director: FleetBudgetDirector | null | undefined,
): FleetBudget | null {
  if (!director) return null;
  const snap = director.fleetManager?.budgetSnapshot?.();
  const maxSpawns = snap?.maxSpawns ?? director.maxSpawns;
  const usedSpawns = snap?.usedSpawns ?? director.spawnCount;
  const remainingSpawns =
    snap?.remainingSpawns ??
    Math.max(0, (Number.isFinite(maxSpawns) ? maxSpawns : Number.POSITIVE_INFINITY) - usedSpawns);
  const activeAgents = director
    .status()
    .subagents.filter((agent) => agent.status === 'running' || agent.status === 'idle').length;
  return {
    maxSpawns,
    usedSpawns,
    remainingSpawns,
    activeAgents,
    ...(snap?.checkpointMaxSpawns !== undefined
      ? { checkpointMaxSpawns: snap.checkpointMaxSpawns }
      : {}),
    ...(snap?.ceilingMismatch ? { ceilingMismatch: true } : {}),
  };
}
