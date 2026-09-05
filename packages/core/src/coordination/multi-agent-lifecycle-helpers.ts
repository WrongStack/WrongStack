import type { TaskSpec } from '../types/multi-agent.js';
import type { FleetBus } from './fleet-bus.js';
import type { SubagentEntry } from './multi-agent-queue-helpers.js';

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
