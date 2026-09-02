import type { SubagentConfig } from '../types/multi-agent.js';
import type { FleetBus, FleetUsage } from './fleet-bus.js';
import type { WorktreeTaskStateUpdate } from './worktree-task-runner.js';

/**
 * Interface for fleet-level lifecycle and policy. Covers:
 * - Spawn lifecycle hooks (canSpawn check, recordSpawn after-effects)
 * - Budget enforcement (fleet-wide cost cap, spawn count/depth caps)
 * - Fleet manifest assembly and writing
 * - Subagent metadata and usage tracking
 *
 * `FleetBus` is pure event fan-out and implements no policy.
 * `FleetManager` encapsulates all fleet-level policy decisions.
 * `Director` currently owns all of this — this interface lets us
 * extract it into a swappable component in Phase 5.
 */
export interface IFleetManager {
  /** The FleetBus this manager publishes lifecycle events to. */
  readonly fleetBus: FleetBus;

  /**
   * Snapshot of fleet-wide token usage and cost rollup.
   * Safe to call from a tool's execute() body.
   */
  snapshot(): FleetUsage;

  /**
   * Per-subagent metadata captured at spawn time (provider/model/name).
   * Returns undefined if the subagent is not known to this manager.
   */
  getSubagentMeta(
    id: string,
  ):
    | { provider?: string | undefined; model?: string | undefined; name?: string | undefined }
    | undefined;

  /**
   * Called before a spawn is recorded. Returns a reason string if the
   * spawn should be rejected (budget cap, depth limit, cost cap, context
   * overload, etc.), or null to proceed. Director.spawn() calls this
   * internally.
   */
  canSpawn(config: SubagentConfig): {
    kind: 'max_spawns' | 'max_spawn_depth' | 'max_cost_usd' | 'max_tokens' | 'max_context_load';
    limit: number;
    observed: number;
  } | null;

  /** Current fleet-wide token/cost ceiling and remaining headroom. */
  budgetSnapshot?:
    | (() => {
        maxSpawns: number;
        usedSpawns: number;
        remainingSpawns: number;
        maxTokens: number;
        usedTokens: number;
        remainingTokens: number;
        maxCostUsd: number;
        usedCostUsd: number;
        remainingCostUsd: number;
        checkpointMaxSpawns?: number | undefined;
        ceilingMismatch?: boolean | undefined;
      })
    | undefined;

  /**
   * Update the leader agent's current context pressure (tokens used in the
   * full API request: messages + systemPrompt + toolDefs). The fleet manager
   * checks this before allowing a new spawn to prevent the leader from
   * overflowing its context window while orchestrating subagents.
   */
  setLeaderContextPressure(tokens: number): void;

  /**
   * Assign a memorable nickname (e.g. "Einstein (Bug Hunter)") and mark it
   * as used so it is never reused. The nickname is written back to `config.name`
   * so the coordinator and manifest both see the human-readable name.
   *
   * NOTE: This only assigns the nickname. The caller MUST call `recordSpawn`
   * after `coordinator.spawn()` returns with the real subagentId.
   *
   * Returns the assigned nickname string.
   */
  assignNicknameAndRecord(config: SubagentConfig): string;

  /**
   * Readonly view of already-assigned nickname keys. Used by `Director.spawn()`
   * to avoid assigning the same nickname twice across the fleet.
   */
  readonly usedNicknames: ReadonlySet<string>;

  /**
   * Called after a spawn succeeds. Records metadata for the usage
   * aggregator and manifest.
   *
   * @param priceLookup Per-token rate lookup for cost calculation.
   *   When omitted the cost column in usage snapshots stays at 0.
   */
  recordSpawn(
    subagentId: string,
    config: SubagentConfig,
    priceLookup?: Record<string, number>,
  ): void;

  /**
   * Write the fleet manifest to disk. Returns the path written
   * or null when no manifest path is configured.
   */
  writeManifest(): Promise<string | null>;

  /**
   * Bypass the debounce timer and write the manifest immediately.
   * Clears any pending debounce timer before writing.
   */
  flushManifest(): Promise<void>;

  /**
   * Aggregate fleet-wide status: pending tasks with descriptions and
   * live subagent snapshot from the coordinator. Used by
   * `MultiAgentHost.status()` to eliminate host-side state duplication.
   */
  getFleetStatus(): {
    pending: { taskId: string; description: string; subagentId: string }[];
    live: { subagentId: string; status: string; task?: string | undefined }[];
  };

  /**
   * Register a pending task with its description. Called by
   * `MultiAgentHost.spawn()` after `_spawnAndAssign()` returns so
   * the description is available in `status()` without host-side storage.
   */
  addPendingTask(taskId: string, subagentId: string, description: string): void;

  /** Record the latest git-worktree lifecycle state for a task. */
  recordTaskWorktree(update: WorktreeTaskStateUpdate): void;

  /**
   * Remove a pending task. Called when the task completes so the
   * pending list stays accurate.
   */
  removePendingTask(taskId: string): void;

  /**
   * Wire the coordinator so `getFleetStats()` can delegate to it.
   * Called by `Director` after constructing the coordinator so
   * FleetManager's stats reflect live subagent data.
   */
  setCoordinator(coordinator: {
    getStats(): {
      total: number;
      running: number;
      idle: number;
      stopped: number;
      inFlight: number;
      pending: number;
      completed: number;
    };
  }): void;

  /**
   * Coordinator stats snapshot for the TUI and monitoring tools.
   * Returns actionable counts (total/running/idle/stopped/inFlight/
   * pending/completed) plus per-subagent status details.
   * Delegates to the coordinator when available; returns zeros
   * if the coordinator has not yet been set.
   */
  getFleetStats(): {
    total: number;
    running: number;
    idle: number;
    stopped: number;
    inFlight: number;
    pending: number;
    completed: number;
    subagentStatuses: { subagentId: string; taskId: string; status: string; assigned: boolean }[];
  };

  /**
   * Called when a subagent is removed so the fleet manager can clean up
   * associated state (nickname slots, pending tasks, etc.).
   */
  removeSubagent(subagentId: string): void;

  /**
   * Release all resources held by the fleet manager.
   * Clears any pending manifest debounce timer and disposes the usage aggregator.
   * Call this when the fleet manager is no longer needed (e.g. process shutdown).
   */
  dispose(): void;
}
