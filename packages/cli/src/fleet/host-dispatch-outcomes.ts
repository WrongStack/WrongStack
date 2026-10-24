import type { EventBus } from '@wrongstack/contracts/kernel';
import {
  type DispatchLogEntry,
  recordDispatch,
  recordDispatchOutcome,
} from '@wrongstack/core/agent-catalog';
import type { Director } from '@wrongstack/core/coordination';

/**
 * Workers remembered for outcome joining. A routed worker's tasks finish well
 * within this many later spawns; the cap only keeps a session that spawns for
 * days from growing the map without bound.
 */
const MAX_TRACKED_WORKERS = 1_000;

/**
 * Routing telemetry with outcomes: every routed spawn is recorded as before,
 * and each task its worker finishes adds an outcome line (status, this task's
 * spend, the model it actually ran on) that `/fleet routing` joins back.
 *
 * Only workers that went through `onSpawnRouted` are followed — the leader's
 * own `delegate` / `spawn_subagent` calls. Companions, auto-review and other
 * host-spawned workers never had a routing decision to grade.
 */
export function createDispatchOutcomeRecorder(opts: {
  events: EventBus;
  director: () => Director | undefined;
  projectRoot: string;
}): { onSpawnRouted(entry: DispatchLogEntry): void; dispose(): void } {
  // subagentId → role and the spend already attributed to earlier tasks, so a
  // reused worker's outcome carries its own task's cost, not the running sum.
  const tracked = new Map<string, { role: string; costSeen: number }>();

  const off = opts.events.on('subagent.task_completed', (e) => {
    const worker = tracked.get(e.subagentId);
    if (!worker) return;
    const director = opts.director();
    const usage = director?.usage.snapshot().perSubagent[e.subagentId];
    const resolved = director?.resolvedModelFor(e.subagentId);
    const cost = usage?.cost;
    const taskCost = typeof cost === 'number' ? Math.max(0, cost - worker.costSeen) : undefined;
    if (typeof cost === 'number') worker.costSeen = cost;
    recordDispatchOutcome(
      {
        at: new Date().toISOString(),
        subagentId: e.subagentId,
        role: worker.role,
        status: e.status,
        durationMs: e.durationMs,
        costUsd: taskCost,
        provider: resolved?.provider ?? usage?.provider,
        model: resolved?.model ?? usage?.model,
      },
      opts.projectRoot,
    );
  });

  return {
    onSpawnRouted(entry) {
      recordDispatch(entry, opts.projectRoot);
      if (!entry.subagentId) return;
      tracked.set(entry.subagentId, { role: entry.role, costSeen: 0 });
      if (tracked.size > MAX_TRACKED_WORKERS) {
        const oldest = tracked.keys().next().value;
        if (oldest !== undefined) tracked.delete(oldest);
      }
    },
    dispose: off,
  };
}
