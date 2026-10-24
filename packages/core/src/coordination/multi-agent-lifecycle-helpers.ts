import type { EventEmitter } from 'node:events';
import type { TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { FleetBus } from './fleet-bus.js';
import type { SubagentEntry } from './multi-agent-queue-helpers.js';
import { resolveGracefulFinish } from './subagent-finish.js';

export interface RemoveSubagentParams {
  subagentId: string;
  subagents: Map<string, SubagentEntry>;
  terminating: Set<string>;
  usedNicknames: Set<string>;
  subagentNicknames: Map<string, string>;
  pendingTasks: TaskSpec[];
  fleetBus?: FleetBus | undefined;
  emitCoordinatorStats: () => void;
  emitPendingAborted: (task: TaskSpec, message: string) => void;
}

export function executeRemoveSubagent(params: RemoveSubagentParams): void {
  const {
    subagentId,
    subagents,
    terminating,
    usedNicknames,
    subagentNicknames,
    pendingTasks,
    fleetBus,
    emitCoordinatorStats,
    emitPendingAborted,
  } = params;

  const subagent = subagents.get(subagentId);
  if (!subagent) return;
  const removedSessionId = subagent.sessionId;

  if (subagent.status === 'running' || subagent.status === 'idle') {
    terminating.add(subagentId);
    subagent.abortController.abort();
    subagent.status = 'stopped';
  }

  subagents.delete(subagentId);
  terminating.delete(subagentId);
  const nicknameKey = subagentNicknames.get(subagentId);
  if (nicknameKey) {
    usedNicknames.delete(nicknameKey);
    subagentNicknames.delete(subagentId);
  }

  const orphaned: TaskSpec[] = [];
  for (let i = pendingTasks.length - 1; i >= 0; i--) {
    if (pendingTasks[i]?.subagentId === subagentId) {
      orphaned.unshift(pendingTasks[i]!);
      pendingTasks.splice(i, 1);
    }
  }

  for (const t of orphaned) {
    emitPendingAborted(t, `Subagent "${subagentId}" was removed while task "${t.id}" was pending`);
  }

  fleetBus?.emit({
    subagentId,
    ts: Date.now(),
    type: 'subagent.removed',
    payload: {
      sessionId: removedSessionId,
      subagentId,
    },
  });

  emitCoordinatorStats();
}

export interface StopSessionParams {
  sessionId: string;
  subagents: Map<string, SubagentEntry>;
  pendingTasks: TaskSpec[];
  emitPendingAborted: (task: TaskSpec, message: string) => void;
  stopSubagent: (id: string) => Promise<void>;
}

export async function executeStopSession(params: StopSessionParams): Promise<void> {
  const { sessionId, subagents, pendingTasks, emitPendingAborted, stopSubagent } = params;
  if (!sessionId) return;

  const ids = new Set<string>();
  for (const [id, entry] of subagents) {
    if (entry.sessionId === sessionId) ids.add(id);
  }
  if (ids.size === 0) return;

  const orphaned: TaskSpec[] = [];
  for (let i = pendingTasks.length - 1; i >= 0; i--) {
    const t = pendingTasks[i];
    if (t?.subagentId !== undefined && ids.has(t.subagentId)) {
      orphaned.unshift(t);
      pendingTasks.splice(i, 1);
    }
  }

  for (const t of orphaned) {
    emitPendingAborted(t, `Session "${sessionId}" was stopped while task "${t.id}" was pending`);
  }

  await Promise.allSettled([...ids].map((id) => stopSubagent(id)));
}

/**
 * Mark a subagent stopped: flag it terminating, abort its run, sever its
 * bridge, and announce the stop. The caller re-emits coordinator stats.
 */
export function markSubagentStopped(
  subagentId: string,
  subagent: SubagentEntry,
  terminating: Set<string>,
  emitter: EventEmitter,
  fleetBus: FleetBus | undefined,
): void {
  // Mark terminating BEFORE the abort so a synchronous tryDispatchNext
  // observation in another callback path sees the intent and skips
  // this subagent. Cleared by recordCompletion once the runner's
  // catch block lands the terminal TaskResult.
  terminating.add(subagentId);

  // Abort any in-flight run, then sever the bridge so further messages fail
  // fast instead of silently queueing on a dead subagent.
  subagent.abortController.abort();
  subagent.status = 'stopped';
  subagent.currentTask = undefined;
  subagent.context.parentBridge = null;

  emitter.emit('subagent.stopped', { subagentId, reason: 'stopped by coordinator' });

  const sessionId = subagent.sessionId;
  fleetBus?.emit({
    subagentId,
    ts: Date.now(),
    type: 'subagent.stopped',
    payload: {
      sessionId,
      subagentId,
      reason: 'stopped by coordinator',
    },
  });
}

/**
 * Ask every RUNNING subagent that opted into `gracefulFinish` and has
 * actually started to finish its task in its own turn. Returns the number
 * of subagents notified.
 */
export function notifyRunningSubagentsToFinish(
  subagents: Iterable<SubagentEntry>,
  reason: string,
): number {
  let notified = 0;
  for (const subagent of subagents) {
    if (subagent.status !== 'running') continue;
    if (!resolveGracefulFinish(subagent.config)) continue;
    const budget = subagent.activeBudget;
    if (!budget) continue;
    // "Wrap up," never "skip your work": only subagents that have actually
    // started (an iteration or tool call on record) are asked to accelerate.
    // A just-spawned subagent — typically a post-session reviewer whose
    // runner has only just wired its bus — would otherwise read the finish
    // notice at its FIRST iteration, before it has examined anything, and a
    // compliant model would emit a truncated report. Subagents that have
    // not started yet stay on their normal lifecycle; the watchdog
    // deadline crossing delivers the in-band notice with a grace window,
    // which is the mandatory path for stalled runs.
    const usage = budget.usage();
    if (usage.iterations === 0 && usage.toolCalls === 0) continue;
    // Notify only — no grace grant. A subagent still well inside its
    // wall-clock budget keeps its full legitimate working time; one already
    // past its deadline has (or will) get grace from the watchdog.
    if (budget.notifyFinish(reason)) notified++;
  }
  return notified;
}
