/**
 * Checkpoint + manifest wiring for the Director.
 *
 * Owns the subset of `Director` logic that touches the on-disk
 * `DirectorStateCheckpoint` and the debounced fleet `manifest.json`
 * writer. Extracted out of `director.ts` to keep that file under
 * review-able size — these helpers still operate on a `Director`
 * instance via the narrow `DirectorCheckpointHost` interface, so
 * there's no state duplication.
 *
 * Public surface (called from `Director` methods):
 *   - `appendSessionEvent`     — best-effort session log append
 *   - `scheduleManifest`       — debounced manifest writer
 *   - `writeManifest`          — actual atomic write
 *   - `setCheckpointState`     — push snapshot into checkpoint
 *   - `acquireCheckpointLock`  — lock the checkpoint for resume
 *   - `resumeFromCheckpoint`   — re-attach to a loaded snapshot
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { DirectorStateCheckpoint, DirectorStateSnapshot } from '../storage/director-state.js';
import type { TaskResult } from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import { atomicWrite } from '../utils/atomic-write.js';

/**
 * Narrow interface the helpers in this file need from the Director.
 * Kept here (instead of importing the full Director class) to avoid a
 * circular import: director.ts re-exports the helpers.
 */
export interface DirectorCheckpointHost {
  readonly id: string;
  readonly manifestPath?: string | undefined;
  readonly manifestDebounceMs: number;
  readonly stateCheckpoint: DirectorStateCheckpoint | null;
  readonly sessionWriter: SessionWriter | null;
  readonly usage: { snapshot(): unknown };
  /** The set of { subagentId, taskIds, ... } manifest rows. */
  readonly manifestEntries: Map<string, unknown>;
  /** Final status of completed tasks, indexed by taskId. */
  readonly completed?: Map<string, TaskResult> | undefined;
  completedResult?(taskId: string): TaskResult | undefined;
  onManifestTimerFired?(): void;
  /**
   * Called from async failure paths in the manifest writer — when the
   * debounced flush or atomic write fails. Implementations funnel
   * through `process.emitWarning` so the director can be torn down
   * even when manifests are unwritable.
   */
  logShutdownError(phase: string, err: unknown): void;
}

/** Best-effort session-writer append. Swallows failures — the director
 *  must not break a fleet run because the session JSONL handle closed. */
export async function appendSessionEvent(
  host: DirectorCheckpointHost,
  event: Parameters<SessionWriter['append']>[0],
): Promise<void> {
  if (!host.sessionWriter) return;
  try {
    await host.sessionWriter.append(event);
  } catch {
    // ignore
  }
}

/** Debounced manifest writer. A burst of spawn/assign/complete events
 *  collapses into one write. Set `manifestDebounceMs` to 0 to write
 *  synchronously (no debounce); set to negative to disable entirely.
 *
 * Returns the new `setTimeout` handle (or `null` if no timer was
 * scheduled) so the caller can cancel it on shutdown. */
export function scheduleManifest(host: DirectorCheckpointHost): NodeJS.Timeout | null {
  if (!host.manifestPath) return null;
  if (host.manifestDebounceMs === 0) {
    // 0 means instant flush — write synchronously, no timer.
    void writeManifest(host).catch((err) => host.logShutdownError('manifest_write_debounced', err));
    return null;
  }
  if (host.manifestDebounceMs < 0) return null;
  return setTimeout(() => {
    host.onManifestTimerFired?.();
    void writeManifest(host).catch((err) => host.logShutdownError('manifest_write_debounced', err));
  }, host.manifestDebounceMs);
}

/**
 * Write the fleet manifest to `manifestPath`. Returns the path written
 * or null when no path was configured. Captures every spawn + its
 * assigned tasks — paired with per-subagent JSONLs, this is enough to
 * replay an entire director run.
 */
export async function writeManifest(host: DirectorCheckpointHost): Promise<string | null> {
  if (!host.manifestPath) return null;
  // Local narrow types to avoid pulling in the full Director shape.
  type ManifestEntry = {
    taskIds: string[];
    worktrees?: Record<string, unknown> | undefined;
    [k: string]: unknown;
  };
  const manifest = {
    directorRunId: host.id,
    writtenAt: new Date().toISOString(),
    children: Array.from(host.manifestEntries.values()).map((e) => {
      const entry = e as ManifestEntry;
      return {
        ...entry,
        // Surface final status from `completed` when available — manifest
        // becomes much more useful for replay when it carries the
        // success/failure state.
        results: entry.taskIds.map((tid) => {
          const r = host.completedResult?.(tid) ?? host.completed?.get(tid);
          const worktree = entry.worktrees?.[tid];
          return r
            ? {
                taskId: tid,
                status: r.status,
                iterations: r.iterations,
                toolCalls: r.toolCalls,
                durationMs: r.durationMs,
                ...(worktree ? { worktree } : {}),
              }
            : { taskId: tid, status: 'pending' as const, ...(worktree ? { worktree } : {}) };
        }),
      };
    }),
    usage: host.usage.snapshot(),
  };
  await fsp.mkdir(path.dirname(host.manifestPath), { recursive: true });
  await atomicWrite(host.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return host.manifestPath;
}

/** Push a snapshot into the on-disk checkpoint (delegated). */
export function setCheckpointState(
  host: DirectorCheckpointHost,
  snapshot: DirectorStateSnapshot,
): void {
  host.stateCheckpoint?.resume(snapshot);
}

/**
 * Attempt to acquire the checkpoint lock. Must be called before
 * resuming — if another director process is alive, this returns
 * false and the caller should not proceed with the resume.
 */
export async function acquireCheckpointLock(host: DirectorCheckpointHost): Promise<boolean> {
  return host.stateCheckpoint ? host.stateCheckpoint.acquireLock() : true;
}

/**
 * Resume from a prior checkpoint snapshot (loaded via
 * `loadDirectorState()`). Re-attach to the fleet mid-flight so
 * subsequent spawn/assign calls update the checkpoint normally.
 */
export function resumeFromCheckpoint(
  host: DirectorCheckpointHost,
  snapshot: DirectorStateSnapshot,
): void {
  host.stateCheckpoint?.resume(snapshot);
}
