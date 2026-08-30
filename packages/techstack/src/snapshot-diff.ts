/**
 * TechStack — Snapshot diff utility.
 *
 * Compares two snapshots to identify added, removed, and changed dependencies.
 *
 * @see docs/specs/techstack-sdd.md §9
 */

import type { DependencyObservation, Snapshot } from './types.js';

export interface SnapshotDiff {
  added: DependencyObservation[];
  removed: DependencyObservation[];
  changed: Array<{
    name: string;
    ecosystem: string;
    field: string;
    from: string;
    to: string;
  }>;
}

/**
 * Compare two snapshots by dependency name + ecosystem.
 *
 * Returns added (in new but not old), removed (in old but not new), and
 * changed (version/status differences for matching dependencies).
 */
export function diffSnapshots(oldSnapshot: Snapshot, newSnapshot: Snapshot): SnapshotDiff {
  const oldByKey = new Map<string, DependencyObservation>();
  for (const dep of oldSnapshot.dependencies) {
    oldByKey.set(`${dep.ecosystem}:${dep.name}`, dep);
  }

  const newByKey = new Map<string, DependencyObservation>();
  for (const dep of newSnapshot.dependencies) {
    newByKey.set(`${dep.ecosystem}:${dep.name}`, dep);
  }

  const added: DependencyObservation[] = [];
  const removed: DependencyObservation[] = [];
  const changed: SnapshotDiff['changed'] = [];

  // Find added + changed
  for (const [key, newDep] of newByKey) {
    const oldDep = oldByKey.get(key);
    if (!oldDep) {
      added.push(newDep);
      continue;
    }

    // Check version changes
    const fields: Array<keyof DependencyObservation> = [
      'locked',
      'requested',
      'status',
      'latestStable',
    ];
    for (const field of fields) {
      const rawOld = oldDep[field];
      const rawNew = newDep[field];
      if (rawOld === rawNew) continue;
      const oldVal = rawOld != null ? String(rawOld) : '';
      const newVal = rawNew != null ? String(rawNew) : '';
      if (oldVal !== newVal) {
        changed.push({
          name: newDep.name,
          ecosystem: newDep.ecosystem,
          field: String(field),
          from: oldVal,
          to: newVal,
        });
      }
    }
  }

  // Find removed
  for (const [key, oldDep] of oldByKey) {
    if (!newByKey.has(key)) {
      removed.push(oldDep);
    }
  }

  return { added, removed, changed };
}
