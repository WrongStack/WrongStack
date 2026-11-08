/**
 * The engine's fleet gauge, from `fleet.concurrency_update` as the WebUI's fleet summary reads it:
 * workers running against the concurrency ceiling and, when the fleet has a director, spawns used
 * against the spawn budget. One ceiling for the whole engine, so the frame carries no session.
 */
export interface FleetGauge {
  active: number;
  max: number;
  maxSpawns?: number | undefined;
  usedSpawns?: number | undefined;
  remainingSpawns?: number | undefined;
}

const count = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Reads the frame's payload; an unlimited spawn budget arrives as null and is left out. */
export function fleetGauge(payload: Record<string, unknown>): FleetGauge | undefined {
  const active = count(payload['fleetConcurrency']);
  const max = count(payload['fleetConcurrencyMax']);
  if (active === undefined || max === undefined) return undefined;
  const maxSpawns = count(payload['maxSpawns']);
  const usedSpawns = count(payload['usedSpawns']);
  const remainingSpawns = count(payload['remainingSpawns']);
  return {
    active,
    max,
    ...(maxSpawns !== undefined ? { maxSpawns } : {}),
    ...(usedSpawns !== undefined ? { usedSpawns } : {}),
    ...(remainingSpawns !== undefined && maxSpawns !== undefined ? { remainingSpawns } : {}),
  };
}
