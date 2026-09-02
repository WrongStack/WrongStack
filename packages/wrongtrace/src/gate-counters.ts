/**
 * WrongTrace gate-decision counter — hosted in the shared adapter so EVERY
 * process that runs the gate (CLI leader + fleet, standalone WebUI server)
 * records into the same tally contract and the same counters file.
 *
 * Design:
 *   - Pure, transport-agnostic tally: `record()` accepts the typed event;
 *     `snapshot()` returns one number per decision kind.
 *   - Deliberately NOT wired as a new EventBus listener — the host emit
 *     sites call `recordGateDecision()` inside their existing emit
 *     closures, so this module never registers a listener it must remember
 *     to dispose (the EventBus wildcard/named caps punish undisposed
 *     registrations; see the core EventBus leak board card).
 *   - A snapshot is persisted to `<projectRoot>/.wrongstack/
 *     wrongtrace-gate-counters.json` so the standalone `wstack
 *     proxy-status` command (fresh process) can report the latest writer's
 *     CUMULATIVE firing rates — cross-process measurability.
 *
 * Shared file contract (CLI + standalone WebUI): both processes write the
 * same path with the same snapshot shape; each process tallies its own
 * sessions (module singleton per process), and the last writer wins. The
 * CLI persists at session end (finalizeExecutionCleanup); the standalone
 * WebUI server persists on each gate decision (its host session model has
 * no single session-end hook). `wstack proxy-status` reads whatever the
 * latest writer produced.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { WrongTraceGateDecisionEvent } from './hooks.js';

export interface WrongTraceGateCounterSnapshot {
  deny: number;
  allowFragile: number;
  lockAcquired: number;
  lockConflictRace: number;
  lockReleased: number;
  total: number;
}

export interface WrongTraceGateCounter {
  record(event: WrongTraceGateDecisionEvent): void;
  snapshot(): WrongTraceGateCounterSnapshot;
  reset(): void;
}

export function createWrongTraceGateCounter(): WrongTraceGateCounter {
  let deny = 0;
  let allowFragile = 0;
  let lockAcquired = 0;
  let lockConflictRace = 0;
  let lockReleased = 0;

  return {
    record(event) {
      switch (event.kind) {
        case 'deny':
          deny++;
          break;
        case 'allow-fragile':
          allowFragile++;
          break;
        case 'lock-acquired':
          lockAcquired++;
          break;
        case 'lock-conflict-race':
          lockConflictRace++;
          break;
        case 'lock-released':
          lockReleased++;
          break;
      }
    },
    snapshot() {
      return {
        deny,
        allowFragile,
        lockAcquired,
        lockConflictRace,
        lockReleased,
        total: deny + allowFragile + lockAcquired + lockConflictRace + lockReleased,
      };
    },
    reset() {
      deny = 0;
      allowFragile = 0;
      lockAcquired = 0;
      lockConflictRace = 0;
      lockReleased = 0;
    },
  };
}

const COUNTERS_FILE = path.join('.wrongstack', 'wrongtrace-gate-counters.json');

// Process-shared singleton — wired at the host emit sites (CLI leader +
// fleet, standalone WebUI server) and read at session end / on each gate
// decision, without registering any new EventBus listener (the leak
// discipline from the EventBus board card).
const shared = createWrongTraceGateCounter();

/** Record one gate decision into the process-shared tally. */
export function recordGateDecision(event: WrongTraceGateDecisionEvent): void {
  shared.record(event);
}

/** Snapshot the process-shared tally (for session-end persist / doctor). */
export function snapshotGateDecisions(): WrongTraceGateCounterSnapshot {
  return shared.snapshot();
}

export function resetGateDecisions(): void {
  shared.reset();
}

export function countersFilePath(projectRoot: string): string {
  return path.join(projectRoot, COUNTERS_FILE);
}

// In-process serialization so unawaited per-decision persists (the
// standalone WebUI emit closure) cannot interleave: each write awaits the
// previous one, then publishes atomically via temp-file + rename (an
// interrupted write never leaves a truncated counters file).
let persistChain: Promise<void> = Promise.resolve();

/** Best-effort persist — the doctor surface must never fail a session end. */
export function persistWrongTraceGateCounters(
  projectRoot: string,
  snapshot: WrongTraceGateCounterSnapshot,
): Promise<void> {
  // Chain so overlapping callers serialize; fail-open and never reject the
  // returned promise (observability must not break teardown).
  persistChain = persistChain.then(async () => {
    const file = countersFilePath(projectRoot);
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(
        tmp,
        JSON.stringify({ at: new Date().toISOString(), ...snapshot }, null, 2),
        'utf8',
      );
      let renamed = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await fs.rename(tmp, file);
          renamed = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      if (!renamed) {
        await fs.copyFile(tmp, file);
        await fs.unlink(tmp).catch(() => {});
      }
    } catch {
      // best-effort: leave the prior file intact (rename is atomic; a failed
      // write before it only orphans the tmp file).
      try {
        await fs.unlink(tmp).catch(() => {});
      } catch {
        /* ignore */
      }
    }
  });
  return persistChain;
}

export async function loadWrongTraceGateCounters(
  projectRoot: string,
): Promise<WrongTraceGateCounterSnapshot | null> {
  try {
    const raw = await fs.readFile(countersFilePath(projectRoot), 'utf8');
    const parsed = JSON.parse(raw) as Partial<WrongTraceGateCounterSnapshot> & {
      at?: string;
    };
    if (
      typeof parsed.deny !== 'number' ||
      typeof parsed.allowFragile !== 'number' ||
      typeof parsed.lockAcquired !== 'number' ||
      typeof parsed.lockConflictRace !== 'number' ||
      typeof parsed.lockReleased !== 'number'
    ) {
      return null;
    }
    // Strip the `at` timestamp persist adds — the loader returns the pure
    // counter shape so callers (doctor readout, tests) get exactly the
    // snapshot contract, not the storage envelope.
    return {
      deny: parsed.deny,
      allowFragile: parsed.allowFragile,
      lockAcquired: parsed.lockAcquired,
      lockConflictRace: parsed.lockConflictRace,
      lockReleased: parsed.lockReleased,
      total:
        parsed.deny +
        parsed.allowFragile +
        parsed.lockAcquired +
        parsed.lockConflictRace +
        parsed.lockReleased,
    };
  } catch {
    return null;
  }
}

/** Compact one-line report for the doctor surface. */
export function formatGateCounterReport(s: WrongTraceGateCounterSnapshot): string {
  return (
    `deny=${s.deny} allow-fragile=${s.allowFragile} ` +
    `lock-acquired=${s.lockAcquired} lock-conflict-race=${s.lockConflictRace} ` +
    `lock-released=${s.lockReleased} total=${s.total}`
  );
}
