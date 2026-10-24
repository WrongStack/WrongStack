/** Tuning defaults for HqPublisher; split out of publisher.ts. */
import * as v8 from 'node:v8';

/** Event types that carry full chat turns rather than telemetry summaries. */
export const TRANSCRIPT_EVENT_TYPES = new Set<string>(['session.transcript', 'agent.message']);

export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_MAX_MS = 30_000;
export const DEFAULT_DISCOVERY_POLL_MS = 5_000;
export const DEFAULT_MAX_QUEUED_MESSAGES = 2000;
/**
 * Hard byte cap on the enqueue to prevent unbounded RAM growth when HQ is offline.
 *
 * Heap-relative: `min(16 MiB, heap_limit * 0.10)`. The lower bound keeps the cap
 * small in typical V8 configurations (e.g. ~512 MiB limit → 16 MiB cap), while
 * the upper bound prevents the cap from exceeding 10 % of the V8 heap limit in
 * small-container or `--max-old-space-size` scenarios. Operators can override
 * via the `maxQueuedBytes` option — the override takes precedence over this
 * default and is the right escape hatch for long offline periods.
 */
export const DEFAULT_MAX_QUEUED_BYTES = Math.min(
  16 * 1024 * 1024,
  Math.floor(v8.getHeapStatistics().heap_size_limit * 0.1),
);
// Commands originate from an interactive operator console. Keep delivery
// close to WebSocket-real-time while retaining the existing bounded poll
// protocol (which also provides replay after a brief disconnect).
export const DEFAULT_COMMAND_POLL_INTERVAL_MS = 500;
/** Upper bound on the redelivery ledger (server queues at most 200 per client). */
export const MAX_TRACKED_COMMANDS = 500;
export const DEFAULT_COMMAND_POLL_LIMIT = 25;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
