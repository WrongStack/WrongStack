/**
 * WrongTrace gate-decision counter.
 *
 * Consumes the typed `wrongtrace.gate.decision` events the hook pairs emit
 * (leader + fleet runner in the CLI process) so the gate's firing rate is
 * actually measurable — a requirement the hooks themselves cannot satisfy
 * (they emit events; they do not count them).
 *
 * Design:
 *   - Pure, transport-agnostic tally: `record()` accepts the typed event;
 *     `snapshot()` returns one number per decision kind.
 *   - Deliberately NOT wired as a new EventBus listener — the leader and
 *     fleet emit sites call `recordGateDecision()` inside their existing
 *     emit closures, so this module never registers a listener it must
 *     remember to dispose (the EventBus wildcard/named caps punish
 *     undisposed registrations; see the core EventBus leak board card).
 *   - A snapshot is persisted to `<projectRoot>/.wrongstack/
 *     wrongtrace-gate-counters.json` at session end so the standalone
 *     `wstack proxy-status` command (fresh process) can report the last
 *     session's firing rates — cross-process measurability.
 *
 * Standalone-WebUI-server gate decisions live in that process's own
 * EventBus and are NOT counted here (CLI doctor surface covers the CLI
 * process). Noted on the remediation board.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import type { WrongTraceGateDecisionEvent } from '@wrongstack/wrongtrace';

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

// Process-shared singleton — wired at the two CLI emit sites (leader +
// fleet) and read at session end, without registering any new EventBus
// listener (the leak discipline from the EventBus board card).
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

/** Best-effort persist — the doctor surface must never fail a session end. */
export async function persistWrongTraceGateCounters(
  projectRoot: string,
  snapshot: WrongTraceGateCounterSnapshot,
): Promise<void> {
  try {
    const file = countersFilePath(projectRoot);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ at: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
  } catch {
    /* best-effort: observability must not break session teardown */
  }
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
      total: parsed.deny + parsed.allowFragile + parsed.lockAcquired
        + parsed.lockConflictRace + parsed.lockReleased,
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