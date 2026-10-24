import type { SessionWriter } from '@wrongstack/contracts/types/session';

/** Options for constructing a FleetManager. */
export interface FleetManagerOptions {
  manifestPath?: string | undefined;
  sessionsRoot?: string | undefined;
  directorRunId?: string | undefined;
  maxSpawns?: number | undefined;
  maxSpawnDepth?: number | undefined;
  spawnDepth?: number | undefined;
  stateCheckpointPath?: string | undefined;
  sessionWriter?: SessionWriter | undefined;
  manifestDebounceMs?: number | undefined;
  checkpointDebounceMs?: number | undefined;
  directorBudget?:
    | {
        maxCostUsd?: number | undefined;
        maxTokens?: number | undefined;
      }
    | undefined;
  /**
   * Maximum context load (as a fraction of maxContext) the leader agent
   * is allowed to reach before a new spawn is rejected. Default: 0.85.
   * When the leader's context pressure exceeds this threshold, spawning
   * a new subagent is refused — the leader must compact first.
   * Set to 1.0 to disable this check.
   */
  maxLeaderContextLoad?: number | undefined;
  /**
   * Provider's max context window in tokens. Used with `maxLeaderContextLoad`
   * to compute the absolute token threshold. Unset/0 = unknown window, which
   * skips the leader-load check rather than guessing a window.
   *
   * A function may be supplied when the leader can switch models at runtime;
   * canSpawn() reads it lazily so the spawn threshold follows the active model.
   */
  maxContext?: number | (() => number | undefined) | undefined;
}

/** A director-state checkpoint as `FleetManager.restoreFromCheckpoint` reads it. */
export type FleetCheckpointSnapshot = {
  spawnCount: number;
  maxSpawns?: number | undefined;
  version?: 1 | undefined;
  directorRunId?: string | undefined;
  updatedAt?: string | undefined;
  spawnDepth?: number | undefined;
  maxSpawnDepth?: number | undefined;
  directorBudget?:
    | {
        maxCostUsd?: number | undefined;
        maxTokens?: number | undefined;
      }
    | undefined;
  subagents?: unknown[] | undefined;
  tasks?: unknown[] | undefined;
  usage?: unknown | undefined;
};

/** What a checkpoint resume reports about the spawn budget. */
export type FleetCheckpointResume = {
  usedSpawns: number;
  maxSpawns: number;
  remainingSpawns: number;
  checkpointMaxSpawns?: number | undefined;
  ceilingMismatch: boolean;
};

export interface FleetSubagentStatus {
  subagentId: string;
  taskId: string;
  status: string;
  assigned: boolean;
}

/** Coordinator counters plus each live subagent's status. */
export interface FleetStats {
  total: number;
  running: number;
  idle: number;
  stopped: number;
  inFlight: number;
  pending: number;
  completed: number;
  subagentStatuses: FleetSubagentStatus[];
}
