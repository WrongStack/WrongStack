import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { holdManagedWorktree, isManagedWorktreeHeld } from '../src/worktree-hold.js';
import { type RunResult, WorktreeManager } from '../src/worktree-manager.js';

/**
 * F3: isManagedWorktreeHeld must answer with ownership at RESOLUTION time.
 * A same-process hold acquired while the marker read is in flight (Goal
 * acquires right after allocate; SDD sweeps share the process) was invisible
 * to the single pre-await count check, so cleanupAllManaged/removeOne
 * force-removed a live Goal's checkout — the loss holds exist to prevent.
 *
 * Ordering is deterministic: the hold count increments synchronously at
 * acquisition, while the marker read completes on a later I/O callback; the
 * sweep cases gate `worktree list` on a deferred to force the acquisition
 * into the read's flight. No sleeps.
 */

/** Scripted git runner: gated list, recording remove, branch listing. */
function makeRunner(opts: { dir: string; branch: string; listGate?: Promise<void> }) {
  const removals: string[] = [];
  const run = async (args: string[], _cwd: string): Promise<RunResult> => {
    if (args[0] === 'worktree' && args[1] === 'list') {
      if (opts.listGate) await opts.listGate;
      return {
        code: 0,
        stdout: `worktree ${opts.dir}\nbranch refs/heads/${opts.branch}\n\n`,
        stderr: '',
      };
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      removals.push(args[args.length - 1] ?? '');
      return { code: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'branch' && args[1] === '--list') {
      return { code: 0, stdout: `${opts.branch}\n`, stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, removals };
}

it('resolves true for a hold acquired while the marker read is in flight (F3)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'worktree-hold-stale-'));
  const dir = join(root, 'checkout');
  await mkdir(dir, { recursive: true });
  try {
    const check = isManagedWorktreeHeld(root, dir); // count 0 → read in flight
    const release = await holdManagedWorktree(root, dir, 'goal:stale-read');
    await expect(check).resolves.toBe(true);
    await release();
    await expect(isManagedWorktreeHeld(root, dir)).resolves.toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('cleanupAllManaged keeps a checkout held during its marker read (F3)', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worktree-hold-stale-sweep-'));
  const root = join(proj, '.wrongstack', 'worktrees');
  const dir = join(root, 'goal-live');
  await mkdir(dir, { recursive: true });
  let releaseList!: () => void;
  const listGate = new Promise<void>((r) => {
    releaseList = r;
  });
  const { run, removals } = makeRunner({ dir, branch: 'wstack/ap/goal-live', listGate });
  const releases: Array<() => Promise<void>> = [];
  try {
    const wm = new WorktreeManager({ projectRoot: proj, run });
    const sweep = wm.cleanupAllManaged();
    releaseList();
    // The sweep now parks inside isManagedWorktreeHeld's marker read; the
    // Goal hold lands there (count increments synchronously, I/O completes
    // on a later loop turn).
    await Promise.resolve();
    await Promise.resolve();
    releases.push(await holdManagedWorktree(root, dir, 'goal:sweep'));
    await expect(sweep).resolves.toEqual({ removed: 0 });
    expect(removals).toEqual([]);
  } finally {
    for (const release of releases) await release();
    await rm(proj, { recursive: true, force: true });
  }
});

it('removeOne refuses a checkout held during its check, sweeps after release (F3)', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worktree-hold-stale-one-'));
  const root = join(proj, '.wrongstack', 'worktrees');
  const dir = join(root, 'goal-one');
  await mkdir(dir, { recursive: true });
  const { run, removals } = makeRunner({ dir, branch: 'wstack/ap/goal-one' });
  let release: (() => Promise<void>) | undefined;
  try {
    const wm = new WorktreeManager({ projectRoot: proj, run });
    const removing = wm.removeOne(dir); // check starts synchronously
    release = await holdManagedWorktree(root, dir, 'goal:remove-one');
    await expect(removing).resolves.toEqual({ removed: false });
    expect(removals).toEqual([]);
    await release();
    release = undefined;
    await expect(wm.removeOne(dir)).resolves.toEqual({ removed: true });
    expect(removals).toEqual([dir]);
  } finally {
    if (release) await release();
    await rm(proj, { recursive: true, force: true });
  }
});

it('a fully released hold does not block the sweep (F3)', async () => {
  const proj = await mkdtemp(join(tmpdir(), 'worktree-hold-stale-released-'));
  const root = join(proj, '.wrongstack', 'worktrees');
  const dir = join(root, 'transient');
  await mkdir(dir, { recursive: true });
  let releaseList!: () => void;
  const listGate = new Promise<void>((r) => {
    releaseList = r;
  });
  const { run, removals } = makeRunner({ dir, branch: 'wstack/ap/transient', listGate });
  try {
    const wm = new WorktreeManager({ projectRoot: proj, run });
    const sweep = wm.cleanupAllManaged();
    const release = await holdManagedWorktree(root, dir, 'goal:transient');
    await release(); // count 0, marker unlinked before the check starts
    releaseList();
    await expect(sweep).resolves.toEqual({ removed: 1 });
    expect(removals).toEqual([dir]);
  } finally {
    await rm(proj, { recursive: true, force: true });
  }
});
