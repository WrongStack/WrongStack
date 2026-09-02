/**
 * WrongTrace gate-decision counter — CLI re-export shim.
 *
 * The implementation lives in `@wrongstack/wrongtrace/src/gate-counters.ts`
 * so EVERY process that runs the gate (CLI leader + fleet, standalone WebUI
 * server) tallies against the same contract and the same counters file.
 * This file exists only to keep the historical import path alive:
 *   - `execution-cleanup.ts` (dynamic import for session-end persist)
 *   - `brain-and-orchestration.ts` (fleet-runner emit-site recording)
 *   - `subcommands/handlers/diag-doctor.ts` (proxy-status readout)
 *   - `lifecycle-plugins.ts` (leader emit-site recording)
 *   - `tests/wrongtrace-gate-counters.test.ts`
 * All five resolve through this shim; nothing imports the adapter
 * implementation directly from CLI source.
 */
export {
  createWrongTraceGateCounter,
  countersFilePath,
  formatGateCounterReport,
  loadWrongTraceGateCounters,
  persistWrongTraceGateCounters,
  recordGateDecision,
  resetGateDecisions,
  snapshotGateDecisions,
} from '@wrongstack/wrongtrace';
export type {
  WrongTraceGateCounter,
  WrongTraceGateCounterSnapshot,
} from '@wrongstack/wrongtrace';
