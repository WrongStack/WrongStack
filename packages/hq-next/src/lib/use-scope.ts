'use client';

/**
 * The operator's scope as hooks. It lives in the same local prefs the Fleet
 * map always used (`fleet.scope` + the machine or project id), so choosing a
 * machine in the header and in the Fleet toolbar is one choice.
 */
import { setHqFleetPrefs, useHqLocalPrefs } from '@hq/data/local-prefs';
import { useHqStore } from '@hq/data/store/index';
import type { HqSnapshot } from '@wrongstack/hq';
import { useMemo } from 'react';
import { ALL_SCOPE, effectiveScope, type FleetScope, inScope, scopeSnapshot } from './scope';
import { useSurface } from './surface';
import type { HqSurface } from './surface-routes';

/**
 * The stored choice, before checking it against the live fleet. Each surface
 * keeps its own: prefs are shared per origin, and a desktop scope must not
 * narrow the phone (or the other way round).
 */
export function useStoredScope(): FleetScope {
  const fleet = useHqLocalPrefs().fleet;
  const surface = useSurface();
  return useMemo(() => {
    if (surface === 'mobile') {
      return fleet.phoneScope === 'all'
        ? ALL_SCOPE
        : { kind: fleet.phoneScope, id: fleet.phoneScopeId };
    }
    return fleet.scope === 'machine'
      ? { kind: 'machine', id: fleet.machineId }
      : fleet.scope === 'project'
        ? { kind: 'project', id: fleet.projectId }
        : ALL_SCOPE;
  }, [fleet, surface]);
}

/** The scope in force: a machine or project that left the fleet means "all". */
export function useFleetScope(): FleetScope {
  const stored = useStoredScope();
  const snapshot = useHqStore((state) => state.snapshot);
  return useMemo(() => effectiveScope(stored, snapshot), [stored, snapshot]);
}

/** Choose the scope for one surface (the desktop unless told otherwise). */
export function setFleetScope(scope: FleetScope, surface: HqSurface = 'desktop'): void {
  if (surface === 'mobile') {
    setHqFleetPrefs({ phoneScope: scope.kind, phoneScopeId: scope.kind === 'all' ? '' : scope.id });
  } else if (scope.kind === 'machine') setHqFleetPrefs({ scope: 'machine', machineId: scope.id });
  else if (scope.kind === 'project') setHqFleetPrefs({ scope: 'project', projectId: scope.id });
  else setHqFleetPrefs({ scope: 'all' });
}

/** `setFleetScope` bound to the surface this component renders in. */
export function useSetFleetScope(): (scope: FleetScope) => void {
  const surface = useSurface();
  return useMemo(() => (scope: FleetScope) => setFleetScope(scope, surface), [surface]);
}

/** Persisted or live events narrowed to the scope by their envelope. */
export function useScopedEvents<T extends { projectId?: string; clientId?: string }>(
  events: readonly T[],
): T[] {
  const snapshot = useHqStore((state) => state.snapshot);
  const scope = useFleetScope();
  return useMemo(
    () =>
      scope.kind === 'all'
        ? [...events]
        : events.filter((event) =>
            inScope({ projectId: event.projectId, clientId: event.clientId }, scope, snapshot),
          ),
    [events, scope, snapshot],
  );
}

/** The live snapshot narrowed to the scope. */
export function useScopedSnapshot(): HqSnapshot | null {
  const snapshot = useHqStore((state) => state.snapshot);
  const scope = useFleetScope();
  return useMemo(() => scopeSnapshot(snapshot, scope), [snapshot, scope]);
}
