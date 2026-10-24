import type { PhaseGraph } from '@wrongstack/goal';
import type { GoalWsHandlerInternals, WSClient } from './goal-ws-handler-internals.js';
import { errMessage, sendSerialized } from './ws-utils.js';

/**
 * Live board broadcasting for `GoalWebSocketHandler`: the 2s progress/state
 * tick with change detection, the full-state broadcast (plus the run-mirror
 * tap), and the goalId-stamped fan-out / unicast frame writers.
 */
export function startGoalBroadcastTick(self: GoalWsHandlerInternals): void {
  if (self.broadcastInterval) return;
  self.broadcastInterval = setInterval(() => {
    const progress = self.orchestrator?.getProgress();
    if (progress) {
      const progressJson = JSON.stringify(progress);
      if (progressJson !== self.lastProgressJson) {
        self.lastProgressJson = progressJson;
        self.broadcast({ type: 'goal.progress', payload: progress });
      }
    }
    // Change detection: real graph mutations broadcast immediately through
    // their own broadcastState calls; the tick only resyncs when content
    // moved without one. An idle run skips buildState + serialize +
    // fan-out entirely.
    const fingerprint = goalGraphFingerprint(self.graph);
    if (fingerprint !== self.lastGraphFingerprint) self.broadcastState();
  }, 2000);
  self.broadcastInterval.unref?.();
}

export function broadcastGoalState(self: GoalWsHandlerInternals, activePhaseId?: string): void {
  const state = self.buildState(activePhaseId);
  self.broadcast({ type: 'goal.state', payload: state });
  // Feed the run mirror (if any) the same projection so it can sync a kanban
  // board. Best-effort — a mirror error must never break the live broadcast.
  if (self.graph && self.onBoardState) {
    try {
      self.onBoardState(self.graph.id, state);
    } catch (err) {
      self.logger.error(`[Goal] board-state tap failed: ${errMessage(err)}`);
    }
  }
  // Record what clients now have so the tick's change detection does not
  // immediately re-broadcast the same content.
  self.lastGraphFingerprint = goalGraphFingerprint(self.graph);
}

export function broadcastGoalFrame(
  self: GoalWsHandlerInternals,
  msg: { type: string; payload: unknown },
): void {
  if (self.goalId)
    msg = {
      ...msg,
      payload: { ...(msg.payload as Record<string, unknown>), goalId: self.goalId },
    };
  const data = JSON.stringify(msg);
  const frameBytes = Buffer.byteLength(data, 'utf8');
  for (const client of self.clients) {
    sendSerialized(client.ws, data, frameBytes);
  }
}

export function sendGoalFrame(
  goalId: string | undefined,
  client: WSClient,
  msg: { type: string; payload: unknown },
): void {
  if (goalId)
    msg = {
      ...msg,
      payload: { ...(msg.payload as Record<string, unknown>), goalId },
    };
  sendSerialized(client.ws, JSON.stringify(msg));
}

/**
 * Cheap content fingerprint covering exactly what `buildState` renders:
 * graph identity/flags plus per-phase status, timestamps, assignees, and
 * task status counts with the newest task update. Any mutation that would
 * change the projection changes this string, so the 2s tick can skip the
 * full buildState + serialize + fan-out while the graph is idle.
 */
export function goalGraphFingerprint(g: PhaseGraph | null): string {
  if (!g) return '';
  let fp = `${g.title}|${g.autonomous}|${g.updatedAt ?? 0}|${g.phases.size}`;
  for (const p of g.phases.values()) {
    let completed = 0;
    let failed = 0;
    let newestTaskAt = 0;
    for (const t of p.taskGraph.nodes.values()) {
      if (t.status === 'completed') completed++;
      else if (t.status === 'failed') failed++;
      if ((t.updatedAt ?? 0) > newestTaskAt) newestTaskAt = t.updatedAt ?? 0;
    }
    fp += `|${p.id}:${p.status}:${p.updatedAt ?? 0}:${(p.assignedAgents ?? []).join(',')}:${p.taskGraph.nodes.size}:${completed}:${failed}:${newestTaskAt}`;
  }
  return fp;
}
