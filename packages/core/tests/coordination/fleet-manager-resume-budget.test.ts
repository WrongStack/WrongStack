/**
 * Resume budget semantics for issue #323 (revised 2026-08):
 * - usedSpawns (spawnCount) is NOT restored from the checkpoint — the
 *   lifetime budget is scoped to the current director run, so a restarted
 *   session resumes with a fresh budget instead of a possibly-exhausted
 *   counter (this was the WebUI chimera spawn-budget lockup root cause).
 * - live maxSpawns ceiling from construction wins over checkpoint metadata
 * - budgetSnapshot reports remaining + optional mismatch
 */
import { describe, expect, it } from 'vitest';
import { FleetManager } from '../../src/coordination/fleet-manager.js';
import type { DirectorStateSnapshot } from '../../src/storage/director-state.js';

function makeSnapshot(
  partial: Partial<DirectorStateSnapshot> & { spawnCount: number },
): DirectorStateSnapshot {
  return {
    version: 1,
    directorRunId: partial.directorRunId ?? 'run-1',
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
    spawnCount: partial.spawnCount,
    maxSpawns: partial.maxSpawns,
    spawnDepth: partial.spawnDepth ?? 0,
    maxSpawnDepth: partial.maxSpawnDepth ?? 2,
    subagents: partial.subagents ?? [],
    tasks: partial.tasks ?? [],
  };
}

describe('FleetManager.restoreFromCheckpoint', () => {
  it('does not restore usedSpawns; applies the live maxSpawns ceiling and mismatch metadata', () => {
    const fm = new FleetManager({ maxSpawns: 256 });

    const result = fm.restoreFromCheckpoint(makeSnapshot({ spawnCount: 103, maxSpawns: 96 }));

    // The historical counter is deliberately ignored — fresh budget per run.
    expect(result.usedSpawns).toBe(0);
    expect(result.maxSpawns).toBe(256);
    expect(result.remainingSpawns).toBe(256);
    expect(result.checkpointMaxSpawns).toBe(96);
    expect(result.ceilingMismatch).toBe(true);

    expect(fm.budgetSnapshot()).toMatchObject({
      maxSpawns: 256,
      usedSpawns: 0,
      remainingSpawns: 256,
      checkpointMaxSpawns: 96,
      ceilingMismatch: true,
    });

    expect(fm.canSpawn({ name: 'worker' })).toBeNull();
  });

  it('resumes with a fresh budget even when the checkpoint counter met the live ceiling', () => {
    const fm = new FleetManager({ maxSpawns: 100 });
    fm.restoreFromCheckpoint(makeSnapshot({ spawnCount: 100, maxSpawns: 48 }));
    // Previously this restored spawnCount=100 and rejected every spawn for
    // the rest of the session; now the run starts with full headroom.
    expect(fm.canSpawn({ name: 'worker' })).toBeNull();
    expect(fm.budgetSnapshot().remainingSpawns).toBe(100);
  });

  it('does not report mismatch when checkpoint ceiling matches live', () => {
    const fm = new FleetManager({ maxSpawns: 64 });
    const result = fm.restoreFromCheckpoint(makeSnapshot({ spawnCount: 10, maxSpawns: 64 }));
    expect(result.ceilingMismatch).toBe(false);
    expect(result.checkpointMaxSpawns).toBe(64);
    expect(fm.budgetSnapshot().ceilingMismatch).toBeUndefined();
  });

  it('reports mismatch when a finite checkpoint ceiling resumes under a live Infinity ceiling', () => {
    const fm = new FleetManager(); // default: maxSpawns = Infinity
    const result = fm.restoreFromCheckpoint(makeSnapshot({ spawnCount: 5, maxSpawns: 100 }));
    expect(result.checkpointMaxSpawns).toBe(100);
    expect(result.ceilingMismatch).toBe(true);
    expect(fm.budgetSnapshot().ceilingMismatch).toBe(true);
  });
});
