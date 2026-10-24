import type { TaskResult } from '@wrongstack/contracts/types/multi-agent';
import type { DirectorStateCheckpoint, DirectorStateSnapshot } from '../storage/director-state.js';
import type { DirectorBtwNotes } from './director/director-btw-notes.js';
import type { DirectorTaskRegistry } from './director/director-task-registry.js';
import type { FleetBus } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { ManifestEntry } from './fleet-spawn.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import type { WorktreeTaskStateUpdate } from './worktree-task-runner.js';
export interface DirectorTaskNotesHost {
  workCompleteFlag: boolean;
  fleet: FleetBus;
  id: string;
  coordinator: DefaultMultiAgentCoordinator;
  btwNotes: DirectorBtwNotes;
  getLeaderBtwNotes(): string[];
  taskWorktrees: Map<string, WorktreeTaskStateUpdate>;
  tasks: DirectorTaskRegistry;
  manifestEntries: Map<string, unknown>;
  stateCheckpoint: DirectorStateCheckpoint | null;
  fleetManager: FleetManager | undefined;
  scheduleManifest(): void;
  sessionTerminateListeners: Set<(sessionId: string) => void>;
  subagentMeta: Map<
    string,
    { provider?: string | undefined; model?: string | undefined; effort?: string | undefined }
  >;
  maxSpawns: number;
}

export function workComplete(host: DirectorTaskNotesHost): void {
  host.workCompleteFlag = true;
  host.fleet.emit({
    subagentId: host.id,
    ts: Date.now(),
    type: 'director.work_complete',
    payload: {},
  });
}

/**
 * Lift a `work_complete` latch. The latch scopes one job; the Director lives
 * for the whole session, so without this the leader closing one request
 * refused every spawn for every later request in the session. Returns whether
 * a latch was actually lifted.
 */
export function reopenWork(host: DirectorTaskNotesHost): boolean {
  if (!host.workCompleteFlag) return false;
  host.workCompleteFlag = false;
  host.fleet.emit({
    subagentId: host.id,
    ts: Date.now(),
    type: 'director.work_reopened',
    payload: {},
  });
  return true;
}

export function requestFinish(host: DirectorTaskNotesHost, reason: string): number {
  return host.coordinator.requestFinish(reason);
}

export function setLeaderBtwNote(host: DirectorTaskNotesHost, note: string): number {
  return host.btwNotes.add(note);
}

export function getLeaderBtwNotes(host: DirectorTaskNotesHost): string[] {
  return host.btwNotes.drain();
}

export function peekLeaderBtwNotes(host: DirectorTaskNotesHost): string[] {
  return host.btwNotes.peek();
}

export function drainLeaderBtwNotes(host: DirectorTaskNotesHost): string[] {
  return host.getLeaderBtwNotes();
}

export function recordWorktreeTaskUpdate(
  host: DirectorTaskNotesHost,
  update: WorktreeTaskStateUpdate,
): void {
  host.taskWorktrees.set(update.taskId, update);
  const owner = host.tasks.ownerFor(update.taskId) ?? update.subagentId;
  const entry = _asManifestEntry(host.manifestEntries.get(owner));
  if (entry) {
    entry.worktrees = { ...(entry.worktrees ?? {}), [update.taskId]: update };
  }
  host.stateCheckpoint?.recordTaskWorktree(update.taskId, update);
  host.fleetManager?.recordTaskWorktree(update);
  if (!host.fleetManager) host.scheduleManifest();
}

export function markTaskOwned(host: DirectorTaskNotesHost, taskId: string): void {
  host.tasks.markOwned(taskId);
}

export function onSessionTerminate(
  host: DirectorTaskNotesHost,
  listener: (sessionId: string) => void,
): () => void {
  host.sessionTerminateListeners.add(listener);
  return () => {
    host.sessionTerminateListeners.delete(listener);
  };
}

export function observeTask(
  host: DirectorTaskNotesHost,
  taskId: string,
  cb: (result: TaskResult, info: { leaderConsumed: boolean }) => void,
): () => void {
  return host.tasks.observe(taskId, cb);
}

export function subagentIdsForSession(host: DirectorTaskNotesHost, sessionId: string): string[] {
  return host.coordinator.subagentIdsForSession(sessionId);
}

export function getSubagentMeta(
  host: DirectorTaskNotesHost,
  id: string,
):
  | { provider?: string | undefined; model?: string | undefined; name?: string | undefined }
  | undefined {
  const usage = host.subagentMeta.get(id);
  const manifest = _asManifestEntry(host.manifestEntries.get(id));
  if (!usage && !manifest) return undefined;
  return {
    provider: usage?.provider ?? manifest?.provider,
    model: usage?.model ?? manifest?.model,
    name: manifest?.name,
  };
}

export function applyResumeBudget(
  host: DirectorTaskNotesHost,
  snapshot: DirectorStateSnapshot,
): void {
  if (host.fleetManager) {
    host.fleetManager.restoreFromCheckpoint(snapshot);
  }
  // Director owns a parallel checkpoint writer for task events — keep its
  // ceiling metadata aligned with the live construction-time maxSpawns.
  host.stateCheckpoint?.applyLiveMaxSpawns(
    Number.isFinite(host.maxSpawns) ? host.maxSpawns : undefined,
  );
}

function _asManifestEntry(v: unknown): ManifestEntry {
  return v as ManifestEntry;
}
