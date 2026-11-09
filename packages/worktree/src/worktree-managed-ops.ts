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
import { basename, resolve, sep } from 'node:path';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { GitRunner } from './worktree-git.js';
import { isManagedWorktreeHeld } from './worktree-hold.js';
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

/**
 * Comparison key for a checkout path. Windows paths compare case-insensitively:
 * git prints the drive letter upper-case whatever case the caller passed.
 */
export function managedPathKey(p: string): string {
  const abs = resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

function isUnderRoot(dir: string, root: string): boolean {
  const d = managedPathKey(dir);
  const r = managedPathKey(root);
  return d !== r && d.startsWith(r + sep);
}

function protectManagedBranches(
  target: Set<string>,
  rec: { dir: string; branch?: string | undefined },
): void {
  if (rec.branch) target.add(rec.branch);
  const slug = basename(resolve(rec.dir));
  if (slug) target.add(`wstack/ap/${slug}`);
}

export async function cleanupAllManaged(ctx: ManagedOpsContext): Promise<{ removed: number }> {
  const root = resolve(ctx.worktreesRoot);
  let removed = 0;
  const failedDirs = new Set<string>();
  const survivingBranches = new Set<string>();
  let listSucceeded = false;
  try {
    const listed = await ctx.runGit(['worktree', 'list', '--porcelain'], ctx.projectRoot);
    if (listed.code === 0) {
      listSucceeded = true;
    } else {
      for (const h of ctx.handles.values()) {
        failedDirs.add(managedPathKey(h.dir));
        protectManagedBranches(survivingBranches, h);
      }
    }
    // Porcelain emits blank-line-separated records with `worktree <abs-path>`
    // and optional `branch refs/heads/<name>`. Match checkouts under our root.
    let curDir: string | null = null;
    let curBranch: string | undefined;
    const records: Array<{ dir: string; branch?: string | undefined }> = [];
    const flush = (): void => {
      if (curDir) {
        const dir = resolve(curDir);
        if (isUnderRoot(dir, root)) {
          records.push({ dir, branch: curBranch });
        }
      }
      curDir = null;
      curBranch = undefined;
    };
    if (listSucceeded) {
      for (const line of listed.stdout.split('\n')) {
        const m = line.match(/^worktree\s+(.+?)\s*$/);
        if (m?.[1]) {
          flush();
          curDir = m[1];
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
    }

    for (const rec of records) {
      // A checkout held by a live owner (a running isolated Goal, here or in
      // another process) is not a leftover: keep it and its branch, exactly
      // like a checkout whose removal failed.
      if (await isManagedWorktreeHeld(root, rec.dir)) {
        failedDirs.add(managedPathKey(rec.dir));
        protectManagedBranches(survivingBranches, rec);
        continue;
      }
      try {
        const rm = await ctx.runGit(['worktree', 'remove', '--force', rec.dir], ctx.projectRoot);
        if (rm.code === 0) {
          removed++;
        } else {
          failedDirs.add(managedPathKey(rec.dir));
          protectManagedBranches(survivingBranches, rec);
        }
      } catch {
        failedDirs.add(managedPathKey(rec.dir));
        protectManagedBranches(survivingBranches, rec);
      }
    }
  } catch {
    for (const h of ctx.handles.values()) {
      failedDirs.add(managedPathKey(h.dir));
      protectManagedBranches(survivingBranches, h);
    }
  }
  for (const h of ctx.handles.values()) {
    if (failedDirs.has(managedPathKey(h.dir))) {
      survivingBranches.add(h.branch);
    }
  }
  // Delete every wstack/ap/* branch (covers branches whose worktree was already
  // gone, e.g. a merged task whose checkout was released but branch lingered),
  // except branches belonging to checkouts whose removal failed. Only sweep
  // branches when `worktree list` succeeded so held checkouts could be identified.
  if (listSucceeded) {
    try {
      const branches = await ctx.runGit(
        ['branch', '--list', '--format=%(refname:short)', 'wstack/ap/*'],
        ctx.projectRoot,
      );
      if (branches.code === 0) {
        for (const b of branches.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)) {
          if (survivingBranches.has(b) || b.startsWith('-')) continue;
          await ctx.runGit(['branch', '-D', '--', b], ctx.projectRoot);
        }
      }
    } catch {
      // best-effort
    }
  }
  await ctx.runGit(['worktree', 'prune'], ctx.projectRoot).catch(() => undefined);
  // Drop in-memory handles whose checkouts actually came off disk; preserve
  // handles and slugs for checkouts whose removal failed.
  if (failedDirs.size === 0) {
    ctx.handles.clear();
    ctx.usedSlugs.clear();
  } else {
    ctx.usedSlugs.clear();
    for (const [ownerId, h] of [...ctx.handles]) {
      if (failedDirs.has(managedPathKey(h.dir))) {
        ctx.usedSlugs.add(h.slug);
      } else {
        ctx.handles.delete(ownerId);
      }
    }
  }
  ctx.emit('worktree.released', {
    handleId: 'cleanup-all',
    ownerId: 'cleanup-all',
    branch: 'wstack/ap/*',
    kept: failedDirs.size > 0,
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
    if (listed.code === 0) {
      // Porcelain emits blank-line-separated records: `worktree <dir>` then
      // optional `HEAD <sha>` / `branch refs/heads/<name>` lines.
      let curDir: string | null = null;
      let curBranch: string | undefined;
      const flush = (): void => {
        if (curDir) {
          if (isUnderRoot(curDir, root)) {
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
    }
  } catch {
    // best-effort
  }
  let branches: string[] = [];
  try {
    const b = await ctx.runGit(
      ['branch', '--list', '--format=%(refname:short)', 'wstack/ap/*'],
      ctx.projectRoot,
    );
    if (b.code === 0) {
      branches = b.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    }
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
  if (!isUnderRoot(abs, root)) {
    return { removed: false };
  }
  if (await isManagedWorktreeHeld(root, abs)) return { removed: false };
  let removed = false;
  try {
    const rm = await ctx.runGit(['worktree', 'remove', '--force', abs], ctx.projectRoot);
    removed = rm.code === 0;
  } catch {
    // best-effort
  }
  // A failed removal (locked dir, OS file handles) leaves the worktree, its
  // branch, and its commits on disk: return early so the branch ref and every
  // matching in-memory handle survive — only prune and drop handles after the
  // checkout actually came off disk.
  if (!removed) {
    return { removed };
  }
  const matchingHandles = [...ctx.handles.entries()].filter(
    ([, h]) => managedPathKey(h.dir) === managedPathKey(abs),
  );
  const targetBranch = branch ?? matchingHandles[0]?.[1].branch;
  // Defense-in-depth: only delete managed `wstack/ap/*` branches (matching
  // `removeBranch`), never arbitrary user branches or flags.
  if (targetBranch?.startsWith('wstack/ap/')) {
    await ctx.runGit(['branch', '-D', '--', targetBranch], ctx.projectRoot).catch(() => undefined);
  }
  await ctx.runGit(['worktree', 'prune'], ctx.projectRoot).catch(() => undefined);
  // Drop any in-memory handle pointing at this dir and free its slug.
  for (const [ownerId, h] of matchingHandles) {
    if (ctx.handles.get(ownerId) === h) {
      ctx.handles.delete(ownerId);
    }
    ctx.usedSlugs.delete(h.slug);
  }
  return { removed };
}

/**
 * Delete ONE managed branch that has no checkout — the panel's Remove on a
 * branch-only orphan. Only `wstack/ap/*` refs; git itself refuses a branch a
 * worktree still has checked out. Best-effort; never throws.
 */
export async function removeBranch(
  ctx: ManagedOpsContext,
  branch: string,
): Promise<{ removed: boolean }> {
  if (!branch.startsWith('wstack/ap/')) return { removed: false };
  const rm = await ctx
    .runGit(['branch', '-D', '--', branch], ctx.projectRoot)
    .catch(() => undefined);
  return { removed: rm?.code === 0 };
}

export async function cleanupStale(
  ctx: ManagedOpsContext,
): Promise<{ removed: number; detected: number }> {
  const root = resolve(ctx.worktreesRoot);
  let detected = 0;
  const heldBranches = new Set<string>();
  try {
    const listed = await ctx.runGit(['worktree', 'list', '--porcelain'], ctx.projectRoot);
    if (listed.code !== 0) {
      return { removed: 0, detected: 0 };
    }
    let curDir: string | null = null;
    let curBranch: string | undefined;
    const records: Array<{ dir: string; branch?: string | undefined }> = [];
    const flush = (): void => {
      if (curDir) {
        const dir = resolve(curDir);
        if (isUnderRoot(dir, root)) {
          records.push({ dir, branch: curBranch });
        }
      }
      curDir = null;
      curBranch = undefined;
    };
    for (const line of listed.stdout.split('\n')) {
      const m = line.match(/^worktree\s+(.+?)\s*$/);
      if (m?.[1]) {
        flush();
        curDir = m[1];
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

    for (const rec of records) {
      if (await isManagedWorktreeHeld(root, rec.dir)) {
        protectManagedBranches(heldBranches, rec);
      } else {
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
      if (branches.code === 0) {
        detected += branches.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((b) => Boolean(b) && !heldBranches.has(b)).length;
      }
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
