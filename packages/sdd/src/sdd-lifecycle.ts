// SDD run lifecycle — post-run, disk-level operations.
//
// While a run is live, the in-process `SddRunControl` (registered in
// `SddRunRegistry`) owns stop / cleanup / rollback. Once a run finishes the
// registry is cleared and its `WorktreeManager` is gone, so these helpers
// re-derive everything from disk: a fresh `WorktreeManager` for git surgery and
// the persisted board snapshot for the run's base branch + merged commits.
//
// Used by the CLI/WebUI when there is no active run (e.g. `/sdd rollback` after
// the run already settled, or `/sdd destroy` to wipe the project).

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { toErrorMessage } from '@wrongstack/core/utils';
import { WorktreeManager } from '@wrongstack/core/worktree';
import { listBoards, removeBoard } from '@wrongstack/kanban';
import { SddBoardStore } from './sdd-board-store.js';

/** Force-remove every git worktree + branch a previous run left behind. */
export async function cleanupSddWorktrees(projectRoot: string): Promise<{ removed: number }> {
  const wt = new WorktreeManager({ projectRoot });
  return wt.cleanupAllManaged();
}

/**
 * Detect and clean up stale worktrees from a crashed previous run.
 * No-op when the project is clean. Called on SDD/Director boot to
 * prevent orphaned worktrees from conflicting with the next run's
 * `allocate()`.
 *
 * P2 #B6 (sprint2 audit).
 */
export async function cleanupStaleWorktrees(
  projectRoot: string,
): Promise<{ removed: number; detected: number }> {
  const wt = new WorktreeManager({ projectRoot });
  return wt.cleanupStale();
}

export interface CleanupStaleSddOptions {
  projectRoot: string;
  /** Board snapshot dir (`wpaths.projectSddBoards`) — read for the liveness guard. */
  boardsDir: string;
  /** A `running` board updated within this window is treated as live → skip. Default 120_000 (2 min). */
  runningLiveMs?: number | undefined;
  /** A `paused` board updated within this window is treated as live → skip. Default 1_800_000 (30 min). */
  pausedLiveMs?: number | undefined;
  /** Injectable clock for tests. */
  now?: (() => number) | undefined;
}

export interface CleanupStaleSddResult {
  /** True when a sweep ran (orphans were found and removed). */
  swept: boolean;
  removed: number;
  detected: number;
  /** Set when the sweep was skipped because a run appears live. */
  skippedReason?: string | undefined;
}

/**
 * Liveness-guarded stale-worktree sweep for boot + run-start. Worktrees live
 * under `<projectRoot>/.wrongstack/worktrees` and a sweep force-removes ALL of
 * them — so it must NEVER run under a genuinely live run (possibly in another
 * process). The guard reads the latest board: a `running` board updated within
 * `runningLiveMs`, or a `paused` one within `pausedLiveMs`, is treated as live
 * and the sweep is skipped. A crashed run leaves its board frozen as `running`
 * → once it ages past the window it is correctly swept. Any other status
 * (completed / failed / stopped / deadlocked / idle) is always sweepable.
 * Never throws — best-effort cleanup.
 */
export async function cleanupStaleSddWorktrees(
  opts: CleanupStaleSddOptions,
): Promise<CleanupStaleSddResult> {
  const now = opts.now?.() ?? Date.now();
  const store = new SddBoardStore({ baseDir: opts.boardsDir });
  const latest = (await store.list())[0];
  if (latest) {
    const age = now - latest.updatedAt;
    if (latest.status === 'running' && age < (opts.runningLiveMs ?? 120_000)) {
      return {
        swept: false,
        removed: 0,
        detected: 0,
        skippedReason: 'a run appears live (running)',
      };
    }
    if (latest.status === 'paused' && age < (opts.pausedLiveMs ?? 1_800_000)) {
      return { swept: false, removed: 0, detected: 0, skippedReason: 'a run is paused' };
    }
  }
  try {
    const wt = new WorktreeManager({ projectRoot: opts.projectRoot });
    const { removed, detected } = await wt.cleanupStale();
    return { swept: detected > 0, removed, detected };
  } catch {
    return { swept: false, removed: 0, detected: 0 };
  }
}

export interface RollbackFromDiskOptions {
  projectRoot: string;
  /** Directory holding persisted board snapshots (`wpaths.projectSddBoards`). */
  boardsDir: string;
  /** Specific run to roll back. Omit → the most recently updated board. */
  runId?: string | undefined;
}

/**
 * Roll back a finished run's merged commits by reading its persisted board
 * snapshot (base branch + commit SHAs) and reverting each. History-preserving;
 * refuses on a dirty tree or revert conflict (surfaced in `reason`). Returns
 * `ok:false` with a reason when there is no board, no base branch, or nothing to
 * revert.
 */
export async function rollbackSddRunFromDisk(
  opts: RollbackFromDiskOptions,
): Promise<{ ok: boolean; reverted: number; reason?: string }> {
  const store = new SddBoardStore({ baseDir: opts.boardsDir });
  const runId = opts.runId ?? (await store.list())[0]?.runId;
  if (!runId) return { ok: false, reverted: 0, reason: 'no SDD board found to roll back' };

  const snap = await store.load(runId);
  if (!snap) return { ok: false, reverted: 0, reason: `board "${runId}" not found` };
  if (!snap.baseBranch) {
    return {
      ok: false,
      reverted: 0,
      reason: 'this run did not record a base branch (no worktree run)',
    };
  }
  const shas = (snap.mergedCommits ?? []).map((c) => c.sha);
  if (shas.length === 0) {
    return { ok: false, reverted: 0, reason: 'no merged commits recorded for this run' };
  }

  const wt = new WorktreeManager({ projectRoot: opts.projectRoot });
  return wt.revertCommits(snap.baseBranch, shas);
}

export interface DestroySddProjectOptions {
  projectRoot: string;
  /** Resolved wstack paths to delete. */
  paths: {
    projectSpecs: string;
    projectTaskGraphs: string;
    projectSddSession: string;
    projectSddBoards: string;
  };
  /**
   * Also revert this run's already-merged squash commits (history-preserving
   * `git revert`) BEFORE deleting the board that records them. Off by default —
   * a plain destroy wipes worktrees + artifacts but leaves merged commits on the
   * base branch (un-merged worktree work is destroyed regardless, since its
   * branch is force-removed). When on and the working tree is dirty, the revert
   * is refused and surfaced in `revertReason` (the destroy still proceeds).
   */
  revertMerged?: boolean | undefined;
  /** Which run's merged commits to revert. Omit → the most recently updated board. */
  runId?: string | undefined;
}

export interface DestroySddProjectResult {
  worktreesRemoved: number;
  /** Human labels of the artifacts that were deleted. */
  deleted: string[];
  /** Number of merged commits reverted (only when `revertMerged` was set). */
  reverted: number;
  /** Whether the optional merged-commit revert succeeded (undefined → not requested). */
  revertOk?: boolean | undefined;
  /** Why the revert did not fully apply (dirty tree, conflict, nothing to revert). */
  revertReason?: string | undefined;
}

/**
 * Destroy an SDD project: optionally revert its merged commits, then clean every
 * worktree + branch, then delete the on-disk artifacts (specs, task-graphs,
 * session, boards). The revert is opt-in (`revertMerged`) and runs FIRST — it
 * reads the board snapshot that the artifact deletion removes. Best-effort: a
 * missing path is simply skipped. The caller is responsible for stopping any
 * active run first.
 */
export async function destroySddProject(
  opts: DestroySddProjectOptions,
): Promise<DestroySddProjectResult> {
  // 1. Optional merged-commit revert — must read the board before we delete it.
  let reverted = 0;
  let revertOk: boolean | undefined;
  let revertReason: string | undefined;
  if (opts.revertMerged) {
    const r = await rollbackSddRunFromDisk({
      projectRoot: opts.projectRoot,
      boardsDir: opts.paths.projectSddBoards,
      runId: opts.runId,
    }).catch((err) => ({ ok: false, reverted: 0, reason: toErrorMessage(err) }));
    reverted = r.reverted;
    revertOk = r.ok;
    revertReason = r.reason;
  }

  // 2. Force-remove every worktree + branch (incl. un-merged work).
  const { removed } = await cleanupSddWorktrees(opts.projectRoot).catch(() => ({ removed: 0 }));

  // 3. Delete the on-disk artifacts.
  const deleted: string[] = [];
  const rmDir = async (dir: string, label: string) => {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      deleted.push(label);
    } catch {
      // already gone
    }
  };
  const rmFile = async (file: string, label: string) => {
    try {
      await fsp.unlink(file);
      deleted.push(label);
    } catch {
      // already gone
    }
  };

  await rmFile(opts.paths.projectSddSession, 'session');
  // Legacy WebUI wizard path (pre-unification) — keep destroy thorough.
  await rmFile(
    path.join(path.dirname(opts.paths.projectSddSession), 'sdd-wizard-session.json'),
    'wizard-session',
  );
  await rmDir(opts.paths.projectSpecs, 'specs');
  await rmDir(opts.paths.projectTaskGraphs, 'task-graphs');
  await rmDir(opts.paths.projectSddBoards, 'boards');

  // 4. Drop KanbanRunMirror boards tagged `sdd` so the Kanban view does not
  // keep stale run cards after the project is wiped.
  try {
    const mirrors = (await listBoards(opts.projectRoot)).filter((b) => b.tags?.includes('sdd'));
    let mirrorsRemoved = 0;
    for (const b of mirrors) {
      if (await removeBoard(opts.projectRoot, b.id)) mirrorsRemoved++;
    }
    if (mirrorsRemoved > 0) deleted.push(`kanban-mirrors(${mirrorsRemoved})`);
  } catch {
    // Kanban store missing / unreadable — destroy still succeeded on SDD artifacts.
  }

  return { worktreesRemoved: removed, deleted, reverted, revertOk, revertReason };
}

/** Lifecycle operation kinds shared by every surface (WebUI / TUI / CLI). */
export type SddLifecycleOp = 'cleanup_worktrees' | 'rollback' | 'destroy';

export interface SddLifecycleOptions {
  projectRoot: string;
  /** Resolved wstack paths (required for `destroy`; boards dir is enough for `rollback`). */
  paths: {
    projectSpecs: string;
    projectTaskGraphs: string;
    projectSddSession: string;
    projectSddBoards: string;
  };
  /** Target a specific run (rollback / destroy). Omit → most recently updated board. */
  runId?: string | undefined;
  /** `destroy` only: also revert merged commits before wiping. */
  revertMerged?: boolean | undefined;
}

/** Uniform result for any lifecycle op — drives identical UI wording everywhere. */
export interface SddLifecycleResult {
  op: SddLifecycleOp;
  ok: boolean;
  /** Worktrees removed (cleanup_worktrees / destroy). */
  removed?: number | undefined;
  /** Merged commits reverted (rollback / destroy with revertMerged). */
  reverted?: number | undefined;
  /** Artifact labels deleted (destroy). */
  deleted?: string[] | undefined;
  /** Failure / partial reason, surfaced verbatim in the UI. */
  reason?: string | undefined;
}

/**
 * Apply a post-run SDD lifecycle operation from disk and return a uniform result.
 * The single entry point shared by the WebUI board handler, the TUI overlay, and
 * the CLI `/sdd` host so every surface reports the same thing. The caller must
 * ensure no run is active (these operate on git + on-disk state, not the live
 * run) — `cleanup`/`destroy` force-remove worktrees, `rollback` refuses on a
 * dirty tree. Never throws.
 */
export async function applySddLifecycle(
  op: SddLifecycleOp,
  opts: SddLifecycleOptions,
): Promise<SddLifecycleResult> {
  try {
    if (op === 'cleanup_worktrees') {
      const { removed } = await cleanupSddWorktrees(opts.projectRoot);
      return { op, ok: true, removed };
    }
    if (op === 'rollback') {
      const r = await rollbackSddRunFromDisk({
        projectRoot: opts.projectRoot,
        boardsDir: opts.paths.projectSddBoards,
        runId: opts.runId,
      });
      return { op, ok: r.ok, reverted: r.reverted, reason: r.reason };
    }
    // destroy
    const r = await destroySddProject({
      projectRoot: opts.projectRoot,
      paths: opts.paths,
      revertMerged: opts.revertMerged,
      runId: opts.runId,
    });
    return {
      op,
      // The wipe itself is best-effort and always "ok"; a requested-but-refused
      // revert is surfaced via reason without failing the destroy.
      ok: true,
      removed: r.worktreesRemoved,
      reverted: r.reverted,
      deleted: r.deleted,
      reason: r.revertOk === false ? r.revertReason : undefined,
    };
  } catch (err) {
    return { op, ok: false, reason: toErrorMessage(err) };
  }
}
