/**
 * HQ persistence layer — survives HQ server restarts so the command center
 * keeps its event history, snapshot state, cost/activity trends, and (later)
 * alert + command-audit logs across reboots.
 *
 * Three stores, all file-backed under the HQ dataDir
 * (`~/.wrongstack/hq/` by default — see {@link resolveHqDataDir}):
 *
 *  - {@link HqEventLog}       — append-only JSONL of every received event
 *                               envelope, rotated when it exceeds a cap.
 *  - {@link HqSnapshotStore}  — atomic checkpoint of the latest snapshot,
 *                               written on every debounced broadcast.
 *  - {@link HqTimeseriesStore}— time-bucketed cost + activity samples for
 *                               trend charts.
 *
 * Each store lives in its own module under `persistence/`; this file is the
 * facade that re-exports them and composes {@link createHqPersistence}. The
 * shared JSONL read primitives are in `persistence/jsonl-io.ts`.
 *
 * Design constraints (mirrors the codebase conventions):
 *  - All disk writes go through {@link withFileLock} + {@link atomicWrite}
 *    (shared primitives from `utils/atomic-write.ts`) for cross-process safety.
 *  - Every write is best-effort and never throws into the HQ server hot path —
 *    callers wrap in try/catch and degrade to in-memory-only on failure.
 *  - Appends use a FIFO write chain (single in-flight writer) so concurrent
 *    event arrivals don't interleave lines.
 *
 * @module hq/persistence
 */
import { HqKanbanStore } from './kanban-store.js';
import { HqEventLog } from './persistence/event-log.js';
import { HqSimpleLog } from './persistence/simple-log.js';
import { HqSnapshotStore } from './persistence/snapshot-store.js';
import { HqTimeseriesStore } from './persistence/timeseries-store.js';

export { HqKanbanStore } from './kanban-store.js';
export {
  HQ_EVENT_LOG_PRESETS,
  HqEventLog,
  hqEventLogPresetFields,
} from './persistence/event-log.js';
export { HqSimpleLog } from './persistence/simple-log.js';
export { HqSnapshotStore } from './persistence/snapshot-store.js';
export {
  type HqTimeseriesBreakdownEntry,
  type HqTimeseriesSample,
  HqTimeseriesStore,
} from './persistence/timeseries-store.js';

// ── Aggregate persistence facade ─────────────────────────────────────────────

export interface HqPersistence {
  eventLog: HqEventLog;
  snapshotStore: HqSnapshotStore;
  timeseries: HqTimeseriesStore;
  kanban: HqKanbanStore;
  commandLog: HqSimpleLog<unknown>;
  alertLog: HqSimpleLog<unknown>;
}

export function createHqPersistence(dataDir: string): HqPersistence {
  return {
    eventLog: new HqEventLog({ dataDir }),
    snapshotStore: new HqSnapshotStore({ dataDir }),
    timeseries: new HqTimeseriesStore({ dataDir }),
    kanban: new HqKanbanStore(dataDir),
    commandLog: new HqSimpleLog({
      dataDir,
      filename: 'commands.jsonl',
      maxLines: 8_000,
      rotateKeep: 4_000,
      readLimit: 4_000,
    }),
    alertLog: new HqSimpleLog({
      dataDir,
      filename: 'alerts.jsonl',
      maxLines: 2_000,
      rotateKeep: 1_000,
      readLimit: 1_000,
    }),
  };
}
