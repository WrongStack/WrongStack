/**
 * Record shapes for the git-worktree lifecycle.
 *
 * Split out of `worktree-manager.ts`, which re-exports every name here so
 * `worktree-manager.js` stays the import site for consumers.
 *
 * @module worktree/worktree-types
 */
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type {
  AllocateOpts,
  MergeOpts,
  MergeResult,
  WorktreeHandle,
  WorktreeStatus,
} from '@wrongstack/contracts/types/worktree';

export type { AllocateOpts, MergeOpts, MergeResult, WorktreeHandle, WorktreeStatus };

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
