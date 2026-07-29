/**
 * Inventory and cleanup of this project's managed git artifacts — the
 * checkouts under `.wrongstack/worktrees` and the `wstack/ap/*` branches.
 *
 * Split out of `worktree-manager.ts`. These operations are handle-free: they
 * work off `git worktree list --porcelain` rather than the manager's in-memory
 * map, so they also see artifacts left behind by a crashed earlier process.
 * The manager's maps are passed in so a still-live manager forgets what was
 * removed.
 *
 * @module worktree/worktree-managed-ops
 */
import { resolve, sep } from 'node:path';
import type { EventBus } from '../kernel/events.js';
import type { GitRunner } from './worktree-git.js';
import type { WorktreeHandle } from './worktree-types.js';

/** Manager state these operations read and mutate. */
export interface ManagedOpsContext {
  runGit: GitRunner;
  projectRoot: string;
  /** Absolute `.wrongstack/worktrees` root for this project. */
  worktreesRoot: string;
  /** Keyed by ownerId — entries for removed checkouts are dropped. */
  handles: Map<string, WorktreeHandle>;
  usedSlugs: Set<string>;
  emit: (event: Parameters<EventBus['emit']>[0], payload: Parameters<EventBus['emit']>[1]) => void;
}

export async function cleanupAllManaged(ctx: ManagedOpsContext): Promise<{ removed: number }> {
  const root = resolve(ctx.worktreesRoot);
  let removed = 0;
  try {
    const listed = await ctx.runGit(['worktree', 'list', '--porcelain'], ctx.projectRoot);
    // Porcelain emits a `worktree <abs-path>` line per checkout (blank-line
    // separated records). Match the ones under our worktrees root.
    for (const line of listed.stdout.split('\n')) {
      const m = line.match(/^worktree\s+(.+?)\s*$/);
      if (!m?.[1]) continue;
      const dir = resolve(m[1]);
      if (dir !== root && (dir === root || dir.startsWith(root + sep))) {
        const rm = await ctx.runGit(['worktree', 'remove', '--force', dir], ctx.projectRoot);
        if (rm.code === 0) removed++;
      }
    }
  } catch {
    // best-effort
  }
  // Delete every wstack/ap/* branch (covers branches whose worktree was already
  // gone, e.g. a merged task whose checkout was released but branch lingered).
  try {
    const branches = await ctx.runGit(
      ['branch', '--list', '--format=%(refname:short)', 'wstack/ap/*'],
      ctx.projectRoot,
    );
    for (const b of branches.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await ctx.runGit(['branch', '-D', b], ctx.projectRoot);
    }
  } catch {
    // best-effort
  }
  await ctx.runGit(['worktree', 'prune'], ctx.projectRoot).catch(() => undefined);
  // Drop any in-memory handles too, so a still-live manager forgets them.
  ctx.handles.clear();
  ctx.usedSlugs.clear();
  ctx.emit('worktree.released', {
    handleId: 'cleanup-all',
    ownerId: 'cleanup-all',
    branch: 'wstack/ap/*',
    kept: false,
  });
  return { removed };
}

/**
 * Read-only inventory of this project's managed git artifacts: every worktree
 * checkout under the `.wrongstack/worktrees` root (with its branch, when the
 * checkout has one) plus every `wstack/ap/*` branch. Unlike `cleanupStale` /
 * `cleanupAllManaged` this removes nothing — it powers the WebUI worktree panel
 * so the user can SEE orphans before deciding to clean them. Never throws.
 */
export async function listManaged(ctx: ManagedOpsContext): Promise<{
  worktrees: Array<{ dir: string; branch?: string | undefined }>;
  branches: string[];
}> {
  const root = resolve(ctx.worktreesRoot);
  const worktrees: Array<{ dir: string; branch?: string | undefined }> = [];
  try {
    const listed = await ctx.runGit(['worktree', 'list', '--porcelain'], ctx.projectRoot);
    // Porcelain emits blank-line-separated records: `worktree <dir>` then
    // optional `HEAD <sha>` / `branch refs/heads/<name>` lines.
    let curDir: string | null = null;
    let curBranch: string | undefined;
    const flush = (): void => {
      if (curDir) {
        const d = resolve(curDir);
        if (d !== root && d.startsWith(root + sep)) {
          worktrees.push({ dir: curDir, branch: curBranch });
        }
      }
      curDir = null;
      curBranch = undefined;
    };
    for (const line of listed.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        flush();
        curDir = line.slice('worktree '.length).trim();
      } else if (line.startsWith('branch ')) {
        curBranch = line
          .slice('branch '.length)
          .trim()
          .replace(/^refs\/heads\//, '');
      } else if (line.trim() === '') {
        flush();
      }
    }
    flush();
  } catch {
    // best-effort
  }
  let branches: string[] = [];
  try {
    const b = await ctx.runGit(
      ['branch', '--list', '--format=%(refname:short)', 'wstack/ap/*'],
      ctx.projectRoot,
    );
    branches = b.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    // best-effort
  }
  return { worktrees, branches };
}

/**
 * Force-remove ONE managed worktree + (optionally) its branch — the targeted
 * counterpart to `cleanupAllManaged`. Used by the WebUI worktree panel's
 * per-row Remove/Discard. Path-guarded so only checkouts under the project's
 * worktrees root can be removed. Best-effort; never throws.
 */
export async function removeOne(
  ctx: ManagedOpsContext,
  dir: string,
  branch?: string | undefined,
): Promise<{ removed: boolean }> {
  const root = resolve(ctx.worktreesRoot);
  const abs = resolve(dir);
  // Refuse anything outside the managed worktrees root (never the main checkout).
  if (abs === root || !abs.startsWith(root + sep)) {
    return { removed: false };
  }
  let removed = false;
  try {
    const rm = await ctx.runGit(['worktree', 'remove', '--force', abs], ctx.projectRoot);
    removed = rm.code === 0;
  } catch {
    // best-effort
  }
  // Defense-in-depth: never let a branch that could be parsed as a git flag
  // through (a leading `-`). `branch -D --` terminates option parsing.
  if (branch && !branch.startsWith('-')) {
    await ctx.runGit(['branch', '-D', '--', branch], ctx.projectRoot).catch(() => undefined);
  }
  await ctx.runGit(['worktree', 'prune'], ctx.projectRoot).catch(() => undefined);
  // Drop any in-memory handle pointing at this dir.
  for (const [ownerId, h] of [...ctx.handles]) {
    if (resolve(h.dir) === abs) ctx.handles.delete(ownerId);
  }
  return { removed };
}

export async function cleanupStale(
  ctx: ManagedOpsContext,
): Promise<{ removed: number; detected: number }> {
  const root = resolve(ctx.worktreesRoot);
  let detected = 0;
  try {
    const listed = await ctx.runGit(['worktree', 'list', '--porcelain'], ctx.projectRoot);
    for (const line of listed.stdout.split('\n')) {
      const m = line.match(/^worktree\s+(.+?)\s*$/);
      if (!m?.[1]) continue;
      const dir = resolve(m[1]);
      if (dir !== root && (dir === root || dir.startsWith(root + sep))) {
        detected++;
      }
    }
  } catch {
    // git not available or not a repo — nothing to clean
    return { removed: 0, detected: 0 };
  }
  // Also catch dangling `wstack/ap/*` branches whose worktree checkout is
  // already gone (e.g. a crash between `worktree remove` and `branch -D`, or a
  // merged task whose checkout was released but the branch lingered). These
  // are orphans too — without this the worktree-dir-only probe would report
  // "clean" and the branch would accumulate across runs.
  if (detected === 0) {
    try {
      const branches = await ctx.runGit(
        ['branch', '--list', '--format=%(refname:short)', 'wstack/ap/*'],
        ctx.projectRoot,
      );
      detected += branches.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean).length;
    } catch {
      // best-effort
    }
  }
  if (detected === 0) {
    return { removed: 0, detected: 0 };
  }
  // Stale worktrees / branches found — delegate to the full sweep.
  const { removed } = await cleanupAllManaged(ctx);
  return { removed, detected };
}
