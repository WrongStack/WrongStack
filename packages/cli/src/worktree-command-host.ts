/**
 * Host side of `/worktree` (list | merge | prune | clean) for the CLI/TUI.
 *
 * Merge and clean go through {@link WorktreeManager} — the same code the WebUI
 * worktree panel uses — so both surfaces share its rollback, identity fallback
 * and conflict detection. Clean force-removes checkouts, so it refuses while
 * anything could be working in one:
 *   - a managed worktree a run in this process still owns (tracked from the
 *     `worktree.*` events every WorktreeManager here emits: Goal, fleet, SDD);
 *   - a Goal run in any process (the Goal run lease is held for the sweep, so
 *     a run cannot start mid-clean either);
 *   - a live SDD run in any process (the SDD board liveness guard).
 */
import type { EventBus } from '@wrongstack/contracts/kernel';
import { toErrorMessage } from '@wrongstack/core/utils';
import { WorktreeManager } from '@wrongstack/core/worktree';
import { gitText, isGitRepo } from './goal-commands.js';

export type WorktreeAction = 'list' | 'merge' | 'prune' | 'clean';

export interface WorktreeCommandHostDeps {
  projectRoot: string;
  events: EventBus;
  /** True while this process's Goal run is planning or running. */
  isGoalRunActive: () => boolean;
  /** Acquire the project's Goal run lease; throws when another run holds it. */
  acquireGoalRunLease: (ownerId: string) => Promise<() => Promise<void>>;
  /** SDD board snapshot dir — enables the cross-process SDD liveness guard. */
  sddBoardsDir?: string | undefined;
}

export interface WorktreeCommandHost {
  onWorktree: (action: WorktreeAction, target?: string) => Promise<string>;
  dispose: () => void;
}

interface LiveWorktree {
  branch: string;
  dir: string;
}

export function createWorktreeCommandHost(deps: WorktreeCommandHostDeps): WorktreeCommandHost {
  /** Keyed by handleId: worktrees a run in this process currently owns. */
  const live = new Map<string, LiveWorktree>();
  const bus = deps.events as unknown as {
    on(event: string, handler: (payload: unknown) => void): void;
    off(event: string, handler: (payload: unknown) => void): void;
  };
  const onAllocated = (p: unknown): void => {
    const e = p as { handleId?: string; branch?: string; dir?: string };
    if (e.handleId && e.branch) live.set(e.handleId, { branch: e.branch, dir: e.dir ?? '' });
  };
  // merged / conflict / released / failed all end a run's ownership; a kept
  // checkout (conflict, failure) is an orphan the user may clean.
  const onEnded = (p: unknown): void => {
    const e = p as { handleId?: string };
    if (e.handleId === 'cleanup-all') live.clear();
    else if (e.handleId) live.delete(e.handleId);
  };
  const ended = ['worktree.merged', 'worktree.conflict', 'worktree.released', 'worktree.failed'];
  bus.on('worktree.allocated', onAllocated);
  for (const ev of ended) bus.on(ev, onEnded);

  const isLiveBranch = (branch: string): boolean => {
    for (const w of live.values()) if (w.branch === branch) return true;
    return false;
  };

  async function merge(target: string | undefined): Promise<string> {
    const root = deps.projectRoot;
    if (!target) return 'Usage: /worktree merge <branch>';
    if (target.startsWith('-')) return `Refusing unsafe branch name: ${target}`;
    if (isLiveBranch(target)) {
      return `⚠ "${target}" belongs to a running task — let it finish (or stop the run) before merging.`;
    }
    const base = (await gitText(['rev-parse', '--abbrev-ref', 'HEAD'], root)).out || 'HEAD';
    const res = await new WorktreeManager({ projectRoot: root }).mergeBranch(target);
    if (res.ok) return `✓ Merged "${target}" into ${base} (squash).`;
    if (res.conflict) {
      const files = res.conflictFiles?.length ? `\n  ${res.conflictFiles.join('\n  ')}` : '';
      return `⚠ Merge of "${target}" into ${base} hit conflicts and was rolled back.${files}`;
    }
    const reason = (res.reason ?? 'unknown error').trim();
    if (/uncommitted changes/.test(reason)) {
      return `⚠ Working tree has uncommitted changes — commit or stash them before merging "${target}".`;
    }
    // mergeBranch never leaves base dirty: a refused merge or commit is reset.
    return `⚠ Merge of "${target}" into ${base} failed and was rolled back.\n${reason}`;
  }

  async function clean(): Promise<string> {
    const root = deps.projectRoot;
    if (deps.isGoalRunActive()) {
      return '⚠ A Goal run is active — stop it (/goal stop) before cleaning worktrees.';
    }
    if (live.size > 0) {
      return `⚠ ${live.size} worktree(s) are in use by running tasks — let them finish before cleaning.`;
    }

    let releaseLease: (() => Promise<void>) | undefined;
    try {
      releaseLease = await deps.acquireGoalRunLease(`cli-worktree-clean:${process.pid}`);
    } catch (err) {
      return `⚠ Not cleaning worktrees: ${toErrorMessage(err)}`;
    }
    try {
      const wt = new WorktreeManager({ projectRoot: root });
      const before = await wt.listManaged();
      if (deps.sddBoardsDir) {
        const sdd = await import('@wrongstack/sdd');
        const res = await sdd.cleanupStaleSddWorktrees({
          projectRoot: root,
          boardsDir: deps.sddBoardsDir,
          stateTransport: 'kanban',
        });
        if (res.skippedReason) return `⚠ Not cleaning worktrees: ${res.skippedReason}.`;
      } else {
        await wt.cleanupAllManaged();
      }
      const after = await wt.listManaged();
      const removedDirs = before.worktrees.length - after.worktrees.length;
      const removedBranches = before.branches.length - after.branches.length;
      const left =
        after.worktrees.length > 0
          ? `\n⚠ ${after.worktrees.length} worktree(s) could not be removed (files in use?).`
          : '';
      return `🧹 Removed ${removedDirs} worktree(s) and ${removedBranches} branch(es).${left}`;
    } finally {
      await releaseLease().catch(() => undefined);
    }
  }

  return {
    async onWorktree(action, target) {
      const root = deps.projectRoot;
      if (!(await isGitRepo(root))) return '⚠ Not a git repository — worktrees unavailable.';
      switch (action) {
        case 'list': {
          const { out } = await gitText(['worktree', 'list'], root);
          return out || 'No worktrees.';
        }
        case 'prune': {
          await gitText(['worktree', 'prune'], root);
          const { out } = await gitText(['worktree', 'list'], root);
          return `Pruned stale worktree entries.\n${out}`;
        }
        case 'merge':
          return merge(target);
        case 'clean':
          return clean();
        default:
          return `Unknown worktree action: ${action as string}`;
      }
    },
    dispose() {
      bus.off('worktree.allocated', onAllocated);
      for (const ev of ended) bus.off(ev, onEnded);
      live.clear();
    },
  };
}
