/**
 * supervisor-registry — process-wide handle to the active FleetSupervisor.
 *
 * The supervisor is built lazily inside `MultiAgentHost.buildDirector()`
 * (the Director itself is lazy), long after the slash commands were
 * registered — so `/supervisor` cannot receive it by constructor
 * injection. This module is the same indirection `getSddRun` uses for the
 * live SDD run: the host sets the handle when the supervisor starts,
 * clears it on dispose, and the slash command reads it at execution time.
 *
 * @module fleet/supervisor-registry
 */

import type { FleetSupervisor } from '@wrongstack/coordination';

let active: FleetSupervisor | null = null;

export function setActiveFleetSupervisor(supervisor: FleetSupervisor | null): void {
  active = supervisor;
}

export function getActiveFleetSupervisor(): FleetSupervisor | null {
  return active;
}
