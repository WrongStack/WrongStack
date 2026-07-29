/**
 * Record shapes for the git-worktree lifecycle.
 *
 * Split out of `worktree-manager.ts`, which re-exports every name here so
 * `worktree-manager.js` stays the import site for consumers.
 *
 * @module worktree/worktree-types
 */
import type { EventBus } from '../kernel/events.js';

/**
 * Lifecycle of a single worktree handle.
 *
 *   allocating → active → committing → merging → merged
 *                                            └─→ needs-review (conflict, kept)
 *   (any)      → failed
 */
export type WorktreeStatus =
  | 'allocating'
  | 'active'
  | 'committing'
  | 'merging'
  | 'merged'
  | 'needs-review'
  | 'failed';

export interface WorktreeHandle {
  /** Stable id (== slug). Used as the event `handleId`. */
  id: string;
  /** Caller-supplied owner (a phase id in Goal). */
  ownerId: string;
  /** Human label for the owner (phase name). */
  ownerLabel: string;
  slug: string;
  /** Absolute path to the worktree checkout. */
  dir: string;
  /** Branch checked out in the worktree (`wstack/ap/<slug>`). */
  branch: string;
  /** Branch the worktree was forked from and merges back into. */
  baseBranch: string;
  status: WorktreeStatus;
  createdAt: number;
  updatedAt: number;
  /** Diff stats from the last commit. */
  insertions: number;
  deletions: number;
  files: number;
  sha?: string | undefined;
  lastError?: string | undefined;
  conflictFiles?: string[] | undefined;
}

export interface AllocateOpts {
  /** Friendly basis for the slug/branch (e.g. the phase name). */
  slugHint?: string | undefined;
  ownerLabel?: string | undefined;
  /** Override the detected base branch. */
  baseBranch?: string | undefined;
}

export interface MergeOpts {
  squash?: boolean | undefined;
  message?: string | undefined;
  /**
   * Optional conflict resolver. Invoked when the squash-merge conflicts, with
   * the conflicted paths and the base working tree (`cwd`). It must resolve the
   * conflict markers in place and return `true` when done. If it returns `true`
   * and no conflict markers remain, the merge is committed and `merge()` returns
   * `{ ok: true, resolved: true }`. Otherwise the merge is aborted (hard reset)
   * and the handle is parked `needs-review` — exactly as if no resolver were
   * provided, so the base tree is never left dirty.
   */
  resolve?: (info: { conflictFiles: string[]; cwd: string }) => Promise<boolean>;
}

export interface MergeResult {
  ok: boolean;
  conflict?: boolean | undefined;
  conflictFiles?: string[] | undefined;
  stderr?: string | undefined;
  /** True when an initial conflict was successfully resolved by `opts.resolve`. */
  resolved?: boolean | undefined;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeManagerOptions {
  projectRoot: string;
  events?: EventBus | undefined;
  sessionId?: string | (() => string | undefined) | undefined;
  gitBin?: string | undefined;
  /**
   * Test seam. When provided, replaces the real `git` spawn so the manager's
   * sequencing/arg vectors can be asserted without touching a repo.
   */
  run?: (args: string[], cwd: string) => Promise<RunResult>;
}
