import * as fsp from 'node:fs/promises';
import { hostname } from 'node:os';
import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { isPidAlive } from '../utils/pid.js';

/**
 * Director state checkpoint — written incrementally throughout a fleet
 * run so a crashed director can be inspected (and eventually resumed)
 * instead of leaving only a final `fleet.json` manifest after `shutdown()`.
 *
 * Schema is JSON-friendly and deliberately denormalized. Each mutation
 * triggers an atomic-write of the whole file — small payloads (typically
 * < 10 KB even with dozens of subagents) make this cheap.
 */
export interface DirectorSubagentState {
  id: string;
  name?: string | undefined;
  role?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  spawnedAt: string;
}

export interface DirectorTaskState {
  taskId: string;
  subagentId?: string | undefined;
  description?: string | undefined;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout';
  assignedAt?: string | undefined;
  completedAt?: string | undefined;
  iterations?: number | undefined;
  toolCalls?: number | undefined;
  durationMs?: number | undefined;
  error?: string | undefined;
  worktree?: DirectorTaskWorktreeState | undefined;
}

export interface DirectorTaskWorktreeState {
  taskId: string;
  subagentId: string;
  handleId: string;
  dir: string;
  branch: string;
  baseBranch: string;
  status:
    | 'allocated'
    | 'fallback'
    | 'committed'
    | 'merged'
    | 'kept'
    | 'released'
    | 'conflict'
    | 'failed';
  commitSha?: string | undefined;
  conflictFiles?: string[] | undefined;
  error?: string | undefined;
}

export interface DirectorStateSnapshot {
  version: 1;
  directorRunId: string;
  updatedAt: string;
  spawnCount: number;
  maxSpawns?: number | undefined;
  spawnDepth: number;
  maxSpawnDepth: number;
  directorBudget?:
    | {
        maxCostUsd?: number | undefined;
        maxTokens?: number | undefined;
      }
    | undefined;
  subagents: DirectorSubagentState[];
  tasks: DirectorTaskState[];
  /** Aggregated usage snapshot. Optional — populated by the Director on save when available. */
  usage?: unknown | undefined;
}

export async function loadDirectorState(filePath: string): Promise<DirectorStateSnapshot | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as DirectorStateSnapshot;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Lock file entry written when a director starts. Prevents two directors
 * from resuming the same run — the second one sees the lock and refuses
 * rather than corrupting the checkpoint by writing concurrently.
 */
export interface DirectorStateLock {
  pid: number;
  hostname: string;
  startedAt: string;
}

/**
 * Write a lock file to claim this checkpoint. Returns false if the lock
 * is already held by a live process; returns true if the lock was acquired
 * (either the file didn't exist, or the previous holder is dead).
 */
export async function acquireDirectorStateLock(
  lockPath: string,
  processId = process.pid,
): Promise<boolean> {
  return withFileLock(lockPath, async () => {
    let existing: string | undefined;
    try {
      existing = await fsp.readFile(lockPath, 'utf8');
    } catch {
      // No lock file — we're safe to claim
    }

    if (existing) {
      try {
        const lock = JSON.parse(existing) as DirectorStateLock;
        // A live owner still holds this checkpoint — refuse. Only a genuinely
        // dead pid makes the lock stale and overwritable.
        if (typeof lock.pid === 'number' && isPidAlive(lock.pid)) {
          return false;
        }
      } catch {
        // Malformed lock — treat as stale.
      }
    }

    const lock: DirectorStateLock = {
      pid: processId,
      hostname: hostname(),
      startedAt: new Date().toISOString(),
    };
    await atomicWrite(lockPath, JSON.stringify(lock), { mode: 0o600 });
    return true;
  });
}

/**
 * Remove the lock file. Call this on graceful Director.shutdown() so the
 * next director run can claim the checkpoint without stale-lock checks.
 */
export async function releaseDirectorStateLock(lockPath: string): Promise<void> {
  try {
    await fsp.unlink(lockPath);
  } catch {
    // ignore
  }
}

/**
 * In-memory accumulator with atomic-write checkpoint. The Director keeps
 * an instance, mutates it on every spawn/assign/complete/fail event, and
 * the instance debounces writes so a burst of activity collapses into a
 * single disk hit.
 *
 * Supports crash recovery: use `loadDirectorState()` to read an existing
 * checkpoint, then call `DirectorStateCheckpoint.resume(snapshot)` to
 * re-attach to a fleet mid-flight. The lock mechanism ensures no two
 * directors can claim the same checkpoint.
 */
export class DirectorStateCheckpoint {
  private snapshot: DirectorStateSnapshot;
  private readonly filePath: string;
  private readonly lockPath: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly debounceMs: number;
  private writing: Promise<void> | null = null;
  private rewriteRequested = false;

  constructor(
    filePath: string,
    init: {
      directorRunId: string;
      maxSpawns?: number | undefined;
      spawnDepth: number;
      maxSpawnDepth: number;
      directorBudget?:
        | {
            maxCostUsd?: number | undefined;
            maxTokens?: number | undefined;
          }
        | undefined;
    },
    debounceMs = 250,
  ) {
    this.filePath = filePath;
    // Lock file lives alongside the checkpoint — `<path>.lock`
    this.lockPath = `${filePath}.lock`;
    this.debounceMs = debounceMs;
    this.snapshot = {
      version: 1,
      directorRunId: init.directorRunId,
      updatedAt: new Date().toISOString(),
      spawnCount: 0,
      maxSpawns: init.maxSpawns,
      spawnDepth: init.spawnDepth,
      maxSpawnDepth: init.maxSpawnDepth,
      directorBudget: init.directorBudget,
      subagents: [],
      tasks: [],
    };
  }

  /**
   * Attempt to acquire the lock for this checkpoint. Call this before
   * resuming a crashed director run. If it returns false, another
   * director process is still running this fleet — do not resume.
   */
  async acquireLock(): Promise<boolean> {
    return acquireDirectorStateLock(this.lockPath);
  }

  /**
   * Release the lock on graceful shutdown. Call `flush()` first to ensure
   * the final checkpoint state is on disk before removing the lock.
   * Without this, the next resume will see a stale-lock and refuse.
   */
  async releaseLock(): Promise<void> {
    return releaseDirectorStateLock(this.lockPath);
  }

  /**
   * Resume from a snapshot previously loaded via `loadDirectorState()`.
   * Use this when `--resume <runId>` is triggered — the snapshot has
   * the full fleet state (subagents, tasks) from before the crash; the
   * checkpoint continues from there.
   */
  resume(snapshot: DirectorStateSnapshot): void {
    this.snapshot = snapshot;
  }

  /**
   * Reconciles tasks and worktrees that were left in 'running' or 'allocated'
   * state when the previous director crashed. Transitions abandoned tasks to
   * 'failed' with a descriptive error and returns the list of repaired task IDs.
   */
  reconcileCrashedState(
    reason = 'Director crashed or was terminated while task was in flight',
  ): string[] {
    const repairedTaskIds: string[] = [];
    const now = new Date().toISOString();
    this.snapshot = {
      ...this.snapshot,
      tasks: this.snapshot.tasks.map((task) => {
        if (task.status === 'running') {
          repairedTaskIds.push(task.taskId);
          return {
            ...task,
            status: 'failed',
            completedAt: now,
            error: task.error ? `${task.error} (${reason})` : reason,
            worktree:
              task.worktree && task.worktree.status === 'allocated'
                ? { ...task.worktree, status: 'failed', error: reason }
                : task.worktree,
          };
        }
        return task;
      }),
    };
    if (repairedTaskIds.length > 0) {
      this.bumpUpdatedAt();
      this.schedule();
    }
    return repairedTaskIds;
  }

  /**
   * After resume, pin the live spawn ceiling from the current profile/flag
   * while preserving `spawnCount` (cumulative used budget). Checkpoint
   * metadata previously stored a historical `maxSpawns` that can diverge
   * from the live runtime ceiling — operators need the live value to win.
   */
  applyLiveMaxSpawns(maxSpawns: number | undefined): void {
    if (this.snapshot.maxSpawns === maxSpawns) return;
    this.snapshot = {
      ...this.snapshot,
      maxSpawns,
    };
    this.bumpUpdatedAt();
    this.schedule();
  }

  current(): DirectorStateSnapshot {
    return this.snapshot;
  }

  recordSpawn(sub: DirectorSubagentState, spawnCount: number): void {
    this.snapshot = {
      ...this.snapshot,
      spawnCount,
      subagents: [...this.snapshot.subagents.filter((s) => s.id !== sub.id), sub],
    };
    this.bumpUpdatedAt();
    this.schedule();
  }

  recordTaskAssigned(task: DirectorTaskState): void {
    const exists = this.snapshot.tasks.some((t) => t.taskId === task.taskId);
    this.snapshot = {
      ...this.snapshot,
      tasks: exists
        ? this.snapshot.tasks.map((t) => (t.taskId === task.taskId ? { ...t, ...task } : t))
        : [...this.snapshot.tasks, task],
    };
    this.bumpUpdatedAt();
    this.schedule();
  }

  recordTaskStatus(
    taskId: string,
    patch: Partial<DirectorTaskState> & { status: DirectorTaskState['status'] },
  ): void {
    this.snapshot = {
      ...this.snapshot,
      tasks: this.snapshot.tasks.map((t) => (t.taskId === taskId ? { ...t, ...patch } : t)),
    };
    this.bumpUpdatedAt();
    this.schedule();
  }

  recordTaskWorktree(taskId: string, worktree: DirectorTaskWorktreeState): void {
    const exists = this.snapshot.tasks.some((t) => t.taskId === taskId);
    this.snapshot = {
      ...this.snapshot,
      tasks: exists
        ? this.snapshot.tasks.map((t) => (t.taskId === taskId ? { ...t, worktree } : t))
        : [
            ...this.snapshot.tasks,
            {
              taskId,
              subagentId: worktree.subagentId,
              status: 'running',
              worktree,
            },
          ],
    };
    this.bumpUpdatedAt();
    this.schedule();
  }

  setUsage(usage: unknown): void {
    this.snapshot = { ...this.snapshot, usage };
    this.bumpUpdatedAt();
    this.schedule();
  }

  /** Wait for all pending checkpoint writes — used by Director.shutdown(). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.persist();
  }

  private bumpUpdatedAt(): void {
    this.snapshot = { ...this.snapshot, updatedAt: new Date().toISOString() };
  }

  private schedule(): void {
    if (this.writing) {
      this.rewriteRequested = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persist();
    }, this.debounceMs);
  }

  private persist(): Promise<void> {
    if (this.writing) {
      // Share the entire write drain, including the latest snapshot. Awaiting
      // an already-resolved promise here would starve the in-flight file I/O.
      this.rewriteRequested = true;
      return this.writing;
    }
    this.writing = Promise.resolve().then(async () => {
      try {
        do {
          this.rewriteRequested = false;
          try {
            await atomicWrite(this.filePath, JSON.stringify(this.snapshot, null, 2), {
              mode: 0o600,
            });
          } catch (err) {
            console.warn(
              JSON.stringify({
                level: 'warn',
                event: 'director_state.checkpoint_write_failed',
                message: toErrorMessage(err),
                timestamp: new Date().toISOString(),
              }),
            );
          }
        } while (this.rewriteRequested);
      } finally {
        this.writing = null;
      }
    });
    return this.writing;
  }
}
