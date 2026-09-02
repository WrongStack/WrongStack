import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  resolveSubagentWorktreeDecision,
  subagentNeedsWorktree,
  WorktreeIntegrationError,
  wrapSubagentRunnerWithWorktrees,
} from '../../src/coordination/worktree-task-runner.js';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '../../src/types/multi-agent.js';
import type { RunResult } from '../../src/worktree/worktree-manager.js';
import { WorktreeManager } from '../../src/worktree/worktree-manager.js';

function stubRunner(
  script: (args: string[]) => RunResult = () => ({ code: 0, stdout: '', stderr: '' }),
) {
  const calls: Array<{ args: string[]; cwd: string }> = [];
  const run = async (args: string[], cwd: string): Promise<RunResult> => {
    calls.push({ args, cwd });
    return script(args);
  };
  return { calls, run };
}

function makeCtx(over: Partial<SubagentRunContext> = {}): SubagentRunContext {
  return {
    subagentId: 's1',
    config: { name: 'Executor', role: 'executor', tools: ['read', 'write'] },
    budget: {} as never,
    signal: new AbortController().signal,
    bridge: null,
    ...over,
  };
}

const task: TaskSpec = { id: 't1', description: 'change the code' };

// Stub-git tests still hit the real filesystem for the worktrees-root mkdir,
// so the fake project root must be writable on every platform — a literal
// '/repo' EACCES-fails on POSIX CI.
const REPO = path.join(os.tmpdir(), `wtr-repo-${process.pid}`);

describe('worktree task runner', () => {
  it('auto-selects worktrees for side-effectful agents but not read-only reviewers', () => {
    expect(subagentNeedsWorktree({ name: 'Executor', tools: ['read', 'write'] })).toBe(true);
    expect(
      subagentNeedsWorktree({ name: 'Reviewer', role: 'reviewer', tools: ['read', 'diff', 'git'] }),
    ).toBe(false);
    expect(resolveSubagentWorktreeDecision({ name: 'Executor', tools: ['write'] })).toBe(
      'optional',
    );
    expect(
      resolveSubagentWorktreeDecision({ name: 'Executor', tools: ['write'] }, { mode: 'required' }),
    ).toBe('required');
    expect(
      resolveSubagentWorktreeDecision({ name: 'Executor', tools: ['write'], worktree: false }),
    ).toBe('off');
  });

  it('falls back to the shared cwd when optional allocation fails', async () => {
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse') return { code: 0, stdout: 'main\n', stderr: '' };
      if (args[0] === 'worktree' && args[1] === 'add') {
        return { code: 1, stdout: '', stderr: 'fatal: not a repo' };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async (_task: TaskSpec, ctx: SubagentRunContext) => {
      expect(ctx.config.cwd).toBeUndefined();
      return { result: 'ok', iterations: 1, toolCalls: 1 } satisfies SubagentRunOutcome;
    });
    const updates: string[] = [];

    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      onUpdate: (u) => updates.push(u.status),
    });

    await expect(wrapped(task, makeCtx())).resolves.toEqual({
      result: 'ok',
      iterations: 1,
      toolCalls: 1,
    });
    expect(runner).toHaveBeenCalledOnce();
    expect(updates).toEqual(['fallback']);
  });

  it('fails before running the task when required isolation has no manager', async () => {
    const runner = vi.fn(async () => ({ iterations: 1, toolCalls: 1 }));
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      policy: { mode: 'required' },
    });

    await expect(wrapped(task, makeCtx())).rejects.toBeInstanceOf(WorktreeIntegrationError);
    expect(runner).not.toHaveBeenCalled();
  });

  it('runs in the allocated worktree, commits, squash-merges, and releases on success', async () => {
    const { calls, run } = stubRunner((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { code: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { code: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'show') return { code: 0, stdout: '2\t0\tfile.ts\n', stderr: '' };
      if (args[0] === 'config') return { code: 0, stdout: 'User\n', stderr: '' };
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async (_task: TaskSpec, ctx: SubagentRunContext) => {
      expect(ctx.config.cwd?.replace(/\\/g, '/')).toContain(
        `${REPO.replace(/\\/g, '/')}/.wrongstack/worktrees/`,
      );
      return { result: 'done', iterations: 2, toolCalls: 3 };
    });
    const updates: string[] = [];
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      onUpdate: (u) => updates.push(u.status),
    });

    await expect(wrapped(task, makeCtx())).resolves.toEqual({
      result: 'done',
      iterations: 2,
      toolCalls: 3,
    });

    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(true);
    expect(calls.some((c) => c.args[0] === 'merge' && c.args.includes('--squash'))).toBe(true);
    expect(calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'remove')).toBe(true);
    expect(updates).toEqual(['allocated', 'committed', 'merged']);
  });

  it('handles ACP provider — no worktree needed', () => {
    expect(subagentNeedsWorktree({ name: 'ACP-Agent', provider: 'acp' })).toBe(false);
  });

  it('handles agent with no tools and no allowedCapabilities — defaults to worktree', () => {
    expect(subagentNeedsWorktree({ name: 'Generic' })).toBe(true);
  });

  it('resolves to off when policy is disabled', () => {
    expect(
      resolveSubagentWorktreeDecision({ name: 'X', tools: ['write'] }, { enabled: false }),
    ).toBe('off');
  });

  it('resolves to off when policy mode is off', () => {
    expect(resolveSubagentWorktreeDecision({ name: 'X', tools: ['write'] }, { mode: 'off' })).toBe(
      'off',
    );
  });

  it('resolves to required when config.worktree is required', () => {
    expect(resolveSubagentWorktreeDecision({ name: 'X', worktree: 'required' })).toBe('required');
  });

  it('resolves to required when config.worktree is true', () => {
    expect(resolveSubagentWorktreeDecision({ name: 'X', tools: ['read'], worktree: true })).toBe(
      'required',
    );
  });

  it('resolves to off for reviewer with no side effects', () => {
    expect(resolveSubagentWorktreeDecision({ name: 'Reviewer', tools: ['read', 'diff'] })).toBe(
      'off',
    );
  });

  it('WorktreeIntegrationError has the expected shape', () => {
    const err = new WorktreeIntegrationError('test error', {
      taskId: 't1',
      subagentId: 's1',
      branch: 'main',
      conflictFiles: ['a.ts', 'b.ts'],
    });
    expect(err.name).toBe('WorktreeIntegrationError');
    expect(err.message).toBe('test error');
    expect(err.taskId).toBe('t1');
    expect(err.subagentId).toBe('s1');
    expect(err.branch).toBe('main');
    expect(err.conflictFiles).toEqual(['a.ts', 'b.ts']);
  });

  it('WorktreeIntegrationError works without optional fields', () => {
    const err = new WorktreeIntegrationError('minimal', {
      taskId: 't1',
      subagentId: 's1',
    });
    expect(err.branch).toBeUndefined();
    expect(err.conflictFiles).toBeUndefined();
  });

  it('keeps worktree on success when autoMerge is false', async () => {
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { code: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: 'def456\n', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { code: 0, stdout: '', stderr: '' }; // nothing to commit
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async () => ({ result: 'done', iterations: 1, toolCalls: 1 }));
    const updates: string[] = [];
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      policy: { autoMerge: false },
      onUpdate: (u) => updates.push(u.status),
    });

    await wrapped(task, makeCtx());
    // When nothing is committed (diff --cached found nothing), it releases without merge
    expect(updates).toContain('released');
  });

  it('fails with WorktreeIntegrationError when worktree allocation fails in required mode', async () => {
    const { run } = stubRunner(() => ({ code: 1, stdout: '', stderr: 'not a git repo' }));
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async () => ({ iterations: 1, toolCalls: 1 }));
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      policy: { mode: 'required' },
    });

    await expect(wrapped(task, makeCtx())).rejects.toThrow(WorktreeIntegrationError);
  });

  it('runs runner when decision is off', async () => {
    const runner = vi.fn(async () => ({ result: 'ok', iterations: 1, toolCalls: 1 }));
    // Use off policy so the runner is called directly
    const ctx = makeCtx({ config: { name: 'Reader', role: 'reader', tools: ['read'] } });
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      policy: { mode: 'off' },
    });

    const result = await wrapped(task, ctx);
    expect(result).toEqual({ result: 'ok', iterations: 1, toolCalls: 1 });
    expect(runner).toHaveBeenCalledWith(task, expect.objectContaining({ subagentId: 's1' }));
  });

  it('throws WorktreeIntegrationError when merge conflicts', async () => {
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { code: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: 'abc123\n', stderr: '' };
      }
      if (args[0] === 'diff' && args.includes('--cached')) {
        return { code: 1, stdout: '', stderr: '' };
      }
      if (args[0] === 'show') return { code: 0, stdout: '2\t0\tfile.ts\n', stderr: '' };
      if (args[0] === 'config') return { code: 0, stdout: 'User\n', stderr: '' };
      if (args[0] === 'merge') {
        return {
          code: 1,
          stdout: '',
          stderr: 'conflict in file.ts',
          conflict: true,
          conflictFiles: ['file.ts'],
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    });
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async () => ({ result: 'done', iterations: 1, toolCalls: 1 }));
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      onUpdate: () => {},
    });

    await expect(wrapped(task, makeCtx())).rejects.toThrow(WorktreeIntegrationError);
  });

  it('runs onUpdate callback when provided', async () => {
    const { run } = stubRunner(() => ({ code: 0, stdout: '', stderr: '' }));
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async () => ({ result: 'done', iterations: 1, toolCalls: 1 }));
    const onUpdate = vi.fn();
    const ctx = makeCtx({ config: { name: 'Executor', tools: ['write'] } });

    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      onUpdate,
    });

    // When worktree add fails (not a real git repo), it falls back
    await wrapped(task, ctx);
    expect(onUpdate).toHaveBeenCalled();
  });

  it('throws when required worktree allocation fails with error info', async () => {
    const { run } = stubRunner(() => ({ code: 1, stdout: '', stderr: 'fatal: failed' }));
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async () => ({ iterations: 1, toolCalls: 1 }));
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      policy: { mode: 'required' },
    });

    try {
      await wrapped(task, makeCtx());
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(WorktreeIntegrationError);
      expect((e as WorktreeIntegrationError).taskId).toBe('t1');
    }
  });

  it('parkFailedWorktree — runner throws in allocated worktree', async () => {
    const { run } = stubRunner((args) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
        return { code: 0, stdout: 'main\n', stderr: '' };
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return { code: 0, stdout: 'abc789\n', stderr: '' };
      }
      if (args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const worktrees = new WorktreeManager({ projectRoot: REPO, run });
    const runner = vi.fn(async () => {
      throw new Error('runner crashed');
    });
    const updates: string[] = [];
    const wrapped = wrapSubagentRunnerWithWorktrees({
      runner,
      worktrees,
      onUpdate: (u) => updates.push(u.status),
    });

    await expect(wrapped(task, makeCtx())).rejects.toThrow('runner crashed');
    expect(updates).toContain('allocated');
    // Should contain either 'kept' or 'released' from parkFailedWorktree
    expect(updates.some((s) => s === 'kept' || s === 'released')).toBe(true);
  });
});
