import type { TaskNode } from '@wrongstack/core/types';
import type { WorktreeHandle } from '@wrongstack/core/worktree';
import { describe, expect, it, vi } from 'vitest';
import type { SddParallelRunOptions } from '../src/sdd-parallel-run-types.js';
import {
  allocateTaskWorktrees,
  forgetTaskWorktree,
  integrateTaskWorktree,
  resolveTaskWorktrees,
} from '../src/sdd-worktree-integration.js';

function makeTask(id: string, title = `Task ${id}`): TaskNode {
  return {
    id,
    title,
    description: '',
    type: 'feature',
    priority: 'medium',
    status: 'pending',
    createdAt: 0,
    updatedAt: 0,
  };
}

function makeState() {
  return {
    taskCwds: new Map<string, string>(),
    taskBranches: new Map<string, string>(),
    taskWorktrees: new Map<string, WorktreeHandle>(),
    mergedCommits: [] as Array<{ taskId: string; sha: string; title: string }>,
  };
}

function makeHandle(taskId: string): WorktreeHandle {
  return {
    id: `wt-${taskId}`,
    dir: `/worktrees/${taskId}`,
    branch: `branch-${taskId}`,
    status: 'active',
  } as unknown as WorktreeHandle;
}

describe('sdd-worktree-integration', () => {
  it('forgetTaskWorktree removes task tracking and optionally keeps branch', () => {
    const state = makeState();
    const handle = makeHandle('t1');
    state.taskWorktrees.set('t1', handle);
    state.taskCwds.set('t1', '/worktrees/t1');
    state.taskBranches.set('t1', 'branch-t1');

    forgetTaskWorktree(state, 't1', { keepBranchLabel: true });
    expect(state.taskWorktrees.has('t1')).toBe(false);
    expect(state.taskCwds.has('t1')).toBe(false);
    expect(state.taskBranches.get('t1')).toBe('branch-t1');

    forgetTaskWorktree(state, 't1');
    expect(state.taskBranches.has('t1')).toBe(false);
  });

  it('allocateTaskWorktrees handles missing worktrees manager and allocation failures', async () => {
    const state = makeState();
    const tasks = [makeTask('t1'), makeTask('t2')];

    await allocateTaskWorktrees({} as SddParallelRunOptions, state, tasks);
    expect(state.taskWorktrees.size).toBe(0);

    const mockWt = {
      allocate: vi.fn(async (id: string) => {
        if (id.includes('t2')) throw new Error('alloc failed');
        return makeHandle('t1');
      }),
    };
    const tracker = {
      getNode: vi.fn((id: string) => (id === 't1' ? makeTask('t1') : undefined)),
    };
    await allocateTaskWorktrees(
      { worktrees: mockWt as never, tracker: tracker as never } as SddParallelRunOptions,
      state,
      tasks,
    );
    expect(state.taskWorktrees.has('t1')).toBe(true);
    expect(state.taskWorktrees.has('t2')).toBe(false);
  });

  it('resolveTaskWorktrees handles cancelled, completed, failed, and throwing branches', async () => {
    const state = makeState();
    const t1 = makeTask('t1');
    const t2 = makeTask('t2');
    const t3 = makeTask('t3');
    const t4 = makeTask('t4');
    state.taskWorktrees.set('t1', makeHandle('t1'));
    state.taskWorktrees.set('t2', makeHandle('t2'));
    state.taskWorktrees.set('t3', makeHandle('t3'));
    state.taskWorktrees.set('t4', makeHandle('t4'));

    const mockWt = {
      commitAll: vi.fn().mockResolvedValue(undefined),
      merge: vi.fn().mockResolvedValue({ ok: true }),
      release: vi.fn(async (h: WorktreeHandle) => {
        if (h.id.includes('t4')) throw new Error('release boom');
      }),
    };

    const tracker = {
      getNode: vi.fn((id: string) => {
        if (id === 't1') return { ...t1, metadata: { cancelled: true } };
        if (id === 't2') return { ...t2, status: 'completed' };
        if (id === 't3') return { ...t3, status: 'failed' };
        return { ...t4, status: 'unknown' };
      }),
    };

    await resolveTaskWorktrees(
      { worktrees: mockWt as never, tracker: tracker as never } as SddParallelRunOptions,
      state,
      [t1, t2, t3, t4],
    );

    expect(state.taskWorktrees.size).toBe(0);
  });

  it('integrateTaskWorktree covers conflict rollback failure and release rejections', async () => {
    const task = makeTask('t-fail');
    const state = makeState();
    const handle = makeHandle(task.id);
    state.taskWorktrees.set(task.id, handle);

    const abortRun = vi.fn();
    const emit = vi.fn();

    const mockWtFatal = {
      commitAll: vi.fn().mockResolvedValue(undefined),
      baseHead: vi.fn().mockResolvedValue('base-sha-1'),
      merge: vi.fn(
        async (
          _h: unknown,
          opts: { resolve?: (info: { conflictFiles: string[]; cwd: string }) => unknown },
        ) => {
          if (opts.resolve) await opts.resolve({ conflictFiles: ['conf.ts'], cwd: '/root' });
          return { ok: true, resolved: true };
        },
      ),
      revertBaseTo: vi.fn().mockRejectedValue(new Error('cannot revert')),
      release: vi.fn().mockRejectedValue(new Error('release fail')),
    };

    const resFatal = await integrateTaskWorktree({
      opts: {
        worktrees: mockWtFatal as never,
        conflictResolver: vi.fn().mockResolvedValue(true),
        verifyTask: vi.fn().mockResolvedValue({ ok: false, reason: 'regressed test' }),
        projectRoot: '/root',
      } as unknown as SddParallelRunOptions,
      state,
      task,
      runId: 'run-1',
      emit,
      abortRun,
    });

    expect(resFatal.ok).toBe(false);
    expect(resFatal.fatal).toBe(true);
    expect(abortRun).toHaveBeenCalled();

    state.taskWorktrees.set(task.id, handle);
    const mockWtRollbackOk = {
      commitAll: vi.fn().mockResolvedValue(undefined),
      baseHead: vi.fn().mockResolvedValue('base-sha-1'),
      merge: vi.fn().mockResolvedValue({ ok: true, resolved: true }),
      revertBaseTo: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockRejectedValue(new Error('release fail 2')),
    };

    const resRollback = await integrateTaskWorktree({
      opts: {
        worktrees: mockWtRollbackOk as never,
        conflictResolver: vi.fn().mockResolvedValue(true),
        verifyTask: vi.fn().mockRejectedValue(new Error('verifier threw')),
        projectRoot: '/root',
      } as unknown as SddParallelRunOptions,
      state,
      task,
      runId: 'run-1',
      emit,
      abortRun,
    });

    expect(resRollback.ok).toBe(false);
    expect(resRollback.reason).toContain('verifier threw');

    state.taskWorktrees.set(task.id, handle);
    const mockWtMergeFail = {
      commitAll: vi.fn().mockResolvedValue(undefined),
      baseHead: vi.fn().mockResolvedValue('base-sha-1'),
      merge: vi.fn().mockResolvedValue({ ok: false, conflictFiles: ['a.ts'] }),
      release: vi.fn().mockRejectedValue(new Error('release fail 3')),
    };

    const resMergeFail = await integrateTaskWorktree({
      opts: {
        worktrees: mockWtMergeFail as never,
      } as unknown as SddParallelRunOptions,
      state,
      task,
      runId: 'run-1',
      emit,
      abortRun,
    });

    expect(resMergeFail.ok).toBe(false);
    expect(resMergeFail.conflictFiles).toEqual(['a.ts']);
  });
});
