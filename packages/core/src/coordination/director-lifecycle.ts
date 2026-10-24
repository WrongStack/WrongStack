import type { Logger } from '@wrongstack/contracts/types/logger';
import type { TaskResult, TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { SessionWriter } from '@wrongstack/contracts/types/session';
import type { DirectorStateCheckpoint } from '../storage/director-state.js';
import type { InMemoryAgentBridge } from './agent-bridge.js';
import type { DirectorBudgetPolicy } from './director/director-budget-policy.js';
import type { DirectorTaskRegistry } from './director/director-task-registry.js';
import type { DirectorIdleRetirement } from './director-idle-retirement.js';
import type { FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { ManifestEntry } from './fleet-spawn.js';
import type { LargeAnswerStore } from './large-answer-store.js';
import type { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import { releaseSubagentSlot } from './session-subagent-models.js';
import { nicknameKeyFromDisplay } from './subagent-nicknames.js';
import type { WorktreeTaskStateUpdate } from './worktree-task-runner.js';

export interface DirectorLifecycleHost {
  clearSubagentIdleRetirement(subagentId: string): void;
  readonly subagentIdleDelayMs: Map<string, number | undefined>;
  appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void>;
  readonly coordinator: DefaultMultiAgentCoordinator;
  readonly subagentBridges: Map<string, InMemoryAgentBridge>;
  readonly usage: FleetUsageAggregator;
  readonly fleetManager: FleetManager | undefined;
  readonly manifestEntries: Map<string, unknown>;
  readonly usedNicknames: Set<string>;
  readonly tasks: DirectorTaskRegistry;
  readonly taskWorktrees: Map<string, WorktreeTaskStateUpdate>;
  readonly budgetPolicy: DirectorBudgetPolicy;
  readonly subagentMeta: Map<
    string,
    { provider?: string | undefined; model?: string | undefined; effort?: string | undefined }
  >;
  readonly priceLookups: Map<
    string,
    {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    }
  >;
  clearManifestTimer(): void;
  taskCompletedListener: ((payload: { task: TaskSpec; result: TaskResult }) => void) | null;
  readonly idleRetirement: DirectorIdleRetirement;
  logShutdownError(phase: string, err: unknown): void;
  readonly bridge: InMemoryAgentBridge;
  readonly manifestWriteChain: Promise<unknown>;
  readonly manifestPath: string | undefined;
  writeManifest(): Promise<string | null>;
  readonly stateCheckpoint: DirectorStateCheckpoint | null;
  readonly largeAnswerStore: LargeAnswerStore;
  readonly sessionTerminateListeners: Set<(sessionId: string) => void>;
  readonly logger: Logger | undefined;
  remove(subagentId: string): Promise<void>;
}

export async function removeDirectorSubagent(
  host: DirectorLifecycleHost,
  subagentId: string,
): Promise<void> {
  // Single reclaim gate for every retirement path (idle reap,
  // retire-on-complete, session terminate, shutdown), so the session's model
  // lane is freed exactly once and the next spawn can reuse it.
  releaseSubagentSlot(subagentId);
  host.clearSubagentIdleRetirement(subagentId);
  host.subagentIdleDelayMs.delete(subagentId);
  void host.appendSessionEvent({
    type: 'agent_stopped',
    ts: new Date().toISOString(),
    agentId: subagentId,
  });
  await host.coordinator.remove(subagentId);

  const bridge = host.subagentBridges.get(subagentId);
  if (bridge) {
    await bridge.stop();
    host.subagentBridges.delete(subagentId);
  }

  host.usage.removeSubagent(subagentId);

  if (host.fleetManager) {
    host.fleetManager.removeSubagent(subagentId);
  } else {
    const entry = asManifestEntry(host.manifestEntries.get(subagentId));
    if (entry?.name) {
      const nicknameKey = nicknameKeyFromDisplay(entry.name);
      if (nicknameKey) host.usedNicknames.delete(nicknameKey);
    }
  }

  const entryForCleanup = asManifestEntry(host.manifestEntries.get(subagentId));
  if (entryForCleanup) {
    host.tasks.removeTasks(entryForCleanup.taskIds);
    for (const tid of entryForCleanup.taskIds) {
      host.taskWorktrees.delete(tid);
    }
  }
  // Path-independent reclaim for the default FleetManager path. The block
  // above only runs on the non-fleet fallback because manifestEntries is
  // populated solely when !host.fleetManager (fleet-spawn.ts:289); with a
  // FleetManager injected it is a no-op, so per-task state used to accumulate
  // for the Director's lifetime:
  //   - registry descriptions (full task briefs, KB-scale) + owners, one per
  //     assigned task;
  //   - taskWorktrees, one WorktreeTaskStateUpdate per worktree task.
  // The registry's owners index and each worktree update's subagentId are
  // populated on every path, so prune from both. Idempotent with the
  // manifest-entry cleanup above (double-delete is a no-op).
  host.tasks.removeTasksOwnedBy(subagentId);
  for (const [taskId, update] of host.taskWorktrees) {
    if (update.subagentId === subagentId) host.taskWorktrees.delete(taskId);
  }
  host.budgetPolicy.removeSubagent(subagentId);
  host.manifestEntries.delete(subagentId);
  // Drop the per-subagent metadata and price-lookup entries that
  // FleetManager records at spawn time (fleet-spawn.ts:254 and
  // fleet-manager.ts:361). When Director runs WITHOUT a fleetManager
  // (the non-fleet fallback path), these Maps live on the Director
  // itself and would otherwise accumulate one entry per retired
  // subagent — same leak FleetManager already fixed internally.
  //
  // priceLookups is keyed by `${provider}/${model}` (shared across
  // subagents using the same model), not by subagentId. Read the
  // provider/model from subagentMeta so we delete exactly the right
  // entry instead of guessing or deleting all entries.
  const meta = host.subagentMeta.get(subagentId);
  if (meta?.provider && meta.model) {
    host.priceLookups.delete(`${meta.provider}/${meta.model}`);
  }
  host.subagentMeta.delete(subagentId);
}

export async function shutdownDirector(host: DirectorLifecycleHost): Promise<void> {
  host.clearManifestTimer();
  if (host.taskCompletedListener) {
    host.coordinator.off('task.completed', host.taskCompletedListener);
    host.taskCompletedListener = null;
  }
  host.budgetPolicy.dispose();
  host.idleRetirement.dispose();
  host.subagentIdleDelayMs.clear();
  await host.coordinator.stopAll();
  host.tasks.resolveWaitersOnShutdown();
  for (const b of host.subagentBridges.values()) {
    await b.stop().catch((err) => host.logShutdownError('subagent_bridge_stop', err));
  }
  host.subagentBridges.clear();
  await host.bridge.stop().catch((err) => host.logShutdownError('director_bridge_stop', err));
  if (host.fleetManager) {
    await host.fleetManager
      .flushManifest()
      .catch((err) => host.logShutdownError('fleet_manifest_flush', err));
    await host.manifestWriteChain.catch(() => undefined);
  } else if (host.manifestPath) {
    await host.writeManifest().catch((err) => host.logShutdownError('manifest_write', err));
  }
  if (host.stateCheckpoint) {
    host.stateCheckpoint.setUsage(host.usage.snapshot());
    await host.stateCheckpoint
      .flush()
      .catch((err) => host.logShutdownError('state_checkpoint_flush', err));
    await host.stateCheckpoint
      .releaseLock()
      .catch((err) => host.logShutdownError('state_checkpoint_lock_release', err));
  }
  host.largeAnswerStore.clear();
}

export async function terminateDirectorSession(
  host: DirectorLifecycleHost,
  sessionId: string,
): Promise<void> {
  if (!sessionId) return;
  // Tell session-scoped owners first (the background delegation tracker),
  // so the `stopped` settlements that follow are attributed to the user.
  for (const listener of [...host.sessionTerminateListeners]) {
    try {
      listener(sessionId);
    } catch (err) {
      host.logger?.warn('[director] session terminate listener failed', { err });
    }
  }
  const ids = host.coordinator.subagentIdsForSession(sessionId);
  if (ids.length === 0) return;
  await host.coordinator.stopSession(sessionId);
  for (const id of ids) {
    void host.remove(id).catch((err) => host.logShutdownError('terminate_session_remove', err));
  }
}

function asManifestEntry(value: unknown): ManifestEntry {
  return value as ManifestEntry;
}
