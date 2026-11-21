import { describe, expect, it } from 'vitest';
import { cleanupAllManaged, type ManagedOpsContext } from '../src/worktree-managed-ops.js';
import type { WorktreeHandle } from '../src/worktree-types.js';

function makeHandle(worktreesRoot: string, ownerId: string, slug: string): WorktreeHandle {
  return {
    id: `wt-${slug}`,
    ownerId,
    slug,
    dir: `${worktreesRoot}/${slug}`,
    branch: `wstack/ap/${slug}`,
    createdAt: new Date().toISOString(),
  } as unknown as WorktreeHandle;
}

describe('cleanupAllManaged concurrent handle ownership', () => {
  it('preserves handles, slugs, and branches allocated while a sweep is in flight', async () => {
    const projectRoot = '/tmp/proj-concurrent-sweep';
    const worktreesRoot = `${projectRoot}/.wrongstack/worktrees`;
    const stale = makeHandle(worktreesRoot, 'owner-stale', 'stale-1');
    const live = makeHandle(worktreesRoot, 'owner-live', 'live-2');

    let enteredRemove!: () => void;
    const removeStarted = new Promise<void>((r) => {
      enteredRemove = r;
    });
    let releaseRemove!: (v: { code: number; stdout: string; stderr: string }) => void;
    const removeGate = new Promise<{ code: number; stdout: string; stderr: string }>((r) => {
      releaseRemove = r;
    });
    const deletedBranches: string[] = [];

    const ctx: ManagedOpsContext = {
      projectRoot,
      worktreesRoot,
      handles: new Map([[stale.ownerId, stale]]),
      usedSlugs: new Set([stale.slug]),
      emit: () => {},
      runGit: async (args) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          return {
            code: 0,
            stdout: `worktree ${stale.dir}\nbranch refs/heads/${stale.branch}\n\n`,
            stderr: '',
          };
        }
        if (args[0] === 'worktree' && args[1] === 'remove') {
          enteredRemove();
          return removeGate;
        }
        if (args[0] === 'branch' && args[1] === '--list') {
          return { code: 0, stdout: `${stale.branch}\n${live.branch}\n`, stderr: '' };
        }
        if (args[0] === 'branch' && args[1] === '-D') {
          deletedBranches.push(args[3]!);
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    const sweep = cleanupAllManaged(ctx);
    await removeStarted;

    ctx.handles.set(live.ownerId, live);
    ctx.usedSlugs.add(live.slug);

    releaseRemove({ code: 0, stdout: '', stderr: '' });
    await sweep;

    expect(ctx.handles.get(live.ownerId)).toBe(live);
    expect(ctx.usedSlugs.has(live.slug)).toBe(true);
    expect(ctx.handles.has(stale.ownerId)).toBe(false);
    expect(ctx.usedSlugs.has(stale.slug)).toBe(false);
    expect(deletedBranches).toEqual([stale.branch]);
  });
});
