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
  const rawMax = snap?.maxSpawns ?? director.maxSpawns;
  const maxSpawns = Number.isNaN(rawMax) ? 0 : Math.max(0, rawMax);
  const rawUsed = snap?.usedSpawns ?? director.spawnCount;
  const usedSpawns = Number.isFinite(rawUsed) && rawUsed > 0 ? rawUsed : 0;
  const remainingSpawns =
    snap?.remainingSpawns !== undefined && !Number.isNaN(snap.remainingSpawns)
      ? Math.max(0, snap.remainingSpawns)
      : Math.max(0, maxSpawns - usedSpawns);
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
