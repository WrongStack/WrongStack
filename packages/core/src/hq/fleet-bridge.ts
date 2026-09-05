/**
 * FleetTelemetryBridge — forwards local multi-agent coordinator stats to the
 * HQ publisher as `fleet.snapshot` envelopes, so the command center can render
 * a global fleet roll-up (queued/completed/failed tasks, per-subagent status,
 * fleet cost) across every connected machine.
 *
 * Source: the `coordinator.stats` EventBus event (originating on the FleetBus
 * and re-emitted onto the host EventBus by `fleet/host.ts`). All payload
 * fields are plain serializable data — no closures, no decoupled relay needed.
 *
 * The snapshot is republished on every `coordinator.stats` change (hash-dedup,
 * mirroring {@link startSessionTelemetryBridge}) so the HQ browser sees live
 * fleet counters without polling.
 *
 * @module hq/fleet-bridge
 */
import type { EventBus } from '../kernel/events.js';
import { type BridgeContextOptions, createBridgeContext } from './bridge-context.js';
import type { HqEventEnvelope, HqFleetSnapshotPayload, HqSubagentSummary } from './protocol.js';

export interface FleetTelemetryBridgeOptions extends BridgeContextOptions {
  /** Local EventBus emitting `coordinator.stats` (host EventBus after the FleetBus hop). */
  events: EventBus;
  /** Coordinator run id — identifies this fleet instance. Falls back to a stable per-session id. */
  runId: string;
}

/**
 * Start forwarding coordinator stats to HQ. Returns a disposer that
 * unsubscribes the listener — call on shutdown.
 */
export function startFleetTelemetryBridge(opts: FleetTelemetryBridgeOptions): () => void {
  const { events, publisher, runId } = opts;
  const ctx = createBridgeContext(opts);
  let lastHash = '';

  function buildPayload(stats: {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    totalCostUsd?: number | undefined;
    maxConcurrent?: number | undefined;
    maxSpawns?: number | undefined;
    usedSpawns?: number | undefined;
    remainingSpawns?: number | undefined;
    effectiveSource?: string | undefined;
    checkpointMaxSpawns?: number | undefined;
    ceilingMismatch?: boolean | undefined;
    subagentStatuses: {
      subagentId: string;
      taskId: string;
      status: string;
      assigned: boolean;
      model?: string | undefined;
      costUsd?: number | undefined;
      runtimeMs?: number | undefined;
      lastActivityAt?: string | undefined;
      iterations?: number | undefined;
      toolCalls?: number | undefined;
    }[];
  }): HqFleetSnapshotPayload {
    const subagents: HqSubagentSummary[] = stats.subagentStatuses.map((s) => ({
      subagentId: s.subagentId,
      ...(s.taskId ? { task: s.taskId } : {}),
      status: normalizeSubagentStatus(s.status),
      ...(s.model !== undefined ? { model: s.model } : {}),
      ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
      ...(s.runtimeMs !== undefined ? { runtimeMs: s.runtimeMs } : {}),
      ...(s.lastActivityAt !== undefined ? { lastActivityAt: s.lastActivityAt } : {}),
    }));
    return {
      runId,
      activeSubagents: stats.running + stats.idle,
      queuedTasks: stats.pending,
      completedTasks: stats.completed,
      failedTasks: stats.stopped,
      ...(stats.totalCostUsd !== undefined ? { totalCostUsd: stats.totalCostUsd } : {}),
      subagents,
      ...(stats.maxConcurrent !== undefined ? { maxConcurrent: stats.maxConcurrent } : {}),
      ...(stats.maxSpawns !== undefined ? { maxSpawns: stats.maxSpawns } : {}),
      ...(stats.usedSpawns !== undefined ? { usedSpawns: stats.usedSpawns } : {}),
      ...(stats.remainingSpawns !== undefined ? { remainingSpawns: stats.remainingSpawns } : {}),
      ...(stats.effectiveSource !== undefined ? { effectiveSource: stats.effectiveSource } : {}),
      ...(stats.checkpointMaxSpawns !== undefined
        ? { checkpointMaxSpawns: stats.checkpointMaxSpawns }
        : {}),
      ...(stats.ceilingMismatch ? { ceilingMismatch: true } : {}),
    };
  }

  /** Last payload published, kept so a reconnect can re-announce it. */
  let lastPayload: HqFleetSnapshotPayload | undefined;

  const publish = (payload: HqFleetSnapshotPayload): void => {
    try {
      publisher.publishFleetSnapshot(payload, {
        ...ctx.sessionIdTag(),
        timestamp: ctx.now(),
      });
    } catch {
      /* best-effort — HQ telemetry must never break the host */
    }
  };

  const off = events.on('coordinator.stats', (stats) => {
    const payload = buildPayload(stats);
    // Hash-dedup so identical fleet state isn't republished.
    const hash = JSON.stringify(payload);
    if (hash === lastHash) return;
    lastHash = hash;
    lastPayload = payload;
    publish(payload);
  });

  // HQ keeps fleet snapshots in a map on the SOCKET, so a reconnect drops
  // them; the hash-dedup above then keeps the fleet invisible until the stats
  // actually change. Re-announce the last known payload instead.
  const offReconnect = publisher.onConnected(() => {
    if (lastPayload !== undefined) publish(lastPayload);
  });

  ctx.track(off);
  ctx.track(offReconnect);
  return ctx.dispose;
}

const FLEET_STATUS_MAP: Record<string, HqSubagentSummary['status']> = {
  running: 'running',
  idle: 'idle',
  pending: 'pending',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  timeout: 'stopped',
  budget_exhausted: 'stopped',
};

function normalizeSubagentStatus(raw: string): HqSubagentSummary['status'] {
  return FLEET_STATUS_MAP[raw] ?? 'idle';
}

/** Re-export for type-only consumers. */
export type { HqEventEnvelope };
