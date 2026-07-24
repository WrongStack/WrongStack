import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addTask, assignTask, createBoard } from '@wrongstack/kanban';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { ToolExecutor } from '../../src/execution/tool-executor.js';
import { EventBus, type EventMap } from '../../src/kernel/events.js';
import { evaluateToolKanbanBoundary } from '../../src/security/kanban-boundary.js';
import type { Tool } from '../../src/types/tool.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('tool Kanban boundary integration', () => {
  it('resolves the current task and evaluates structured paths and shell calls', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-'));
    roots.push(projectRoot);
    const board = await createBoard(projectRoot, {
      title: 'Scoped work',
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'confirm',
        allow: [{ kind: 'package', path: 'packages/webui', access: 'read_write' }],
      },
    });
    const taskResult = await addTask(projectRoot, board.id, { title: 'Edit the WebUI' });
    const task = taskResult!.task;
    const ctx = {
      projectRoot,
      workingDir: projectRoot,
      currentKanbanBoardId: board.id,
      currentKanbanTaskId: task.id,
      meta: {},
    } as unknown as Context;
    const writeTool = { name: 'write', capabilities: ['fs.write'] } as unknown as Tool;
    const bashTool = { name: 'bash', capabilities: ['shell.arbitrary'] } as unknown as Tool;
    const planTool = { name: 'plan', capabilities: ['fs.write'] } as unknown as Tool;
    const designTool = { name: 'design', capabilities: ['fs.write'] } as unknown as Tool;

    await expect(
      evaluateToolKanbanBoundary(writeTool, { path: 'packages/webui/src/new.ts' }, ctx),
    ).resolves.toMatchObject({ decision: 'allow', boardId: board.id, taskId: task.id });
    await expect(
      evaluateToolKanbanBoundary(writeTool, { path: 'packages/core/src/index.ts' }, ctx),
    ).resolves.toMatchObject({ decision: 'block', source: 'board' });
    await expect(
      evaluateToolKanbanBoundary(bashTool, { command: 'pnpm test' }, ctx),
    ).resolves.toMatchObject({ decision: 'confirm', source: 'board' });
    await expect(
      evaluateToolKanbanBoundary(planTool, { action: 'done', target: 'task-123' }, ctx),
    ).resolves.toMatchObject({ decision: 'confirm', source: 'board' });
    await expect(
      evaluateToolKanbanBoundary(
        designTool,
        { action: 'materialize', out: 'packages/core/theme.css' },
        ctx,
      ),
    ).resolves.toMatchObject({ decision: 'block', source: 'board' });

    const boardOnlyCtx = { ...ctx, currentKanbanTaskId: undefined } as Context;
    await expect(
      evaluateToolKanbanBoundary(writeTool, { path: 'packages/core/src/index.ts' }, boardOnlyCtx),
    ).resolves.toMatchObject({ decision: 'block', source: 'board', boardId: board.id });
  });

  it('reads the live policy from the originating project when a worker runs in a worktree', async () => {
    const policyRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-origin-'));
    const worktreeRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-worktree-'));
    roots.push(policyRoot, worktreeRoot);
    const board = await createBoard(policyRoot, {
      title: 'Worktree scope',
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [{ kind: 'directory', path: 'packages/webui', access: 'write' }],
      },
    });
    const task = (await addTask(policyRoot, board.id, { title: 'Scoped worker' }))!.task;
    const ctx = {
      projectRoot: worktreeRoot,
      workingDir: worktreeRoot,
      meta: { kanban: { boardId: board.id, taskId: task.id, projectRoot: policyRoot } },
    } as unknown as Context;
    const writeTool = { name: 'write', capabilities: ['fs.write'] } as unknown as Tool;

    await expect(
      evaluateToolKanbanBoundary(writeTool, { path: 'packages/core/src/index.ts' }, ctx),
    ).resolves.toMatchObject({ decision: 'block', source: 'board' });
  });

  it('does not let an allowed directory escape through a symlink', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-link-'));
    roots.push(projectRoot);
    await mkdir(join(projectRoot, 'packages/webui'), { recursive: true });
    await mkdir(join(projectRoot, 'packages/core'), { recursive: true });
    await symlink(
      join(projectRoot, 'packages/core'),
      join(projectRoot, 'packages/webui/escape'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const board = await createBoard(projectRoot, {
      title: 'Symlink scope',
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [{ kind: 'directory', path: 'packages/webui', access: 'write' }],
      },
    });
    const task = (await addTask(projectRoot, board.id, { title: 'Scoped edit' }))!.task;
    const ctx = {
      projectRoot,
      workingDir: projectRoot,
      currentKanbanBoardId: board.id,
      currentKanbanTaskId: task.id,
      meta: {},
    } as Context;

    await expect(
      evaluateToolKanbanBoundary(
        { name: 'write', capabilities: ['fs.write'] } as unknown as Tool,
        { path: 'packages/webui/escape/index.ts' },
        ctx,
      ),
    ).resolves.toMatchObject({ decision: 'block', source: 'board' });
  });

  it('hard-blocks execution even when the permission policy auto-approves', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-exec-'));
    roots.push(projectRoot);
    const board = await createBoard(projectRoot, {
      title: 'Hard scope',
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'block',
        allow: [{ kind: 'directory', path: 'src', access: 'write' }],
      },
    });
    const task = (await addTask(projectRoot, board.id, { title: 'Scoped edit' }))!.task;
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = {
      name: 'write',
      permission: 'auto',
      mutating: true,
      capabilities: ['fs.write'],
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
      execute,
    } as unknown as Tool;
    const executor = new ToolExecutor(
      { get: (name) => (name === tool.name ? tool : undefined), list: () => [tool] },
      {
        permissionPolicy: {
          evaluate: async () => ({ permission: 'auto', source: 'yolo' }),
        },
        secretScrubber: { scrub: (value: string) => value },
      } as never,
    );
    const ctx = {
      projectRoot,
      workingDir: projectRoot,
      currentKanbanBoardId: board.id,
      currentKanbanTaskId: task.id,
      meta: {},
      signal: new AbortController().signal,
      session: { id: 'boundary-test' },
      agentId: 'worker',
      agentName: 'Worker',
      provider: { id: 'test' },
      model: 'test-model',
    } as Context;

    const result = await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'write-outside',
          name: 'write',
          input: { path: 'packages/core/index.ts', content: 'nope' },
        },
      ],
      ctx,
      'sequential',
    );
    expect(result.outputs[0]?.result).toMatchObject({
      type: 'tool_result',
      is_error: true,
    });
    const firstResult = result.outputs[0]?.result;
    expect(String(firstResult && 'content' in firstResult ? firstResult.content : '')).toContain(
      'blocked by Kanban boundary',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('records a boundary-forced confirmation as the effective decision', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-confirm-'));
    roots.push(projectRoot);
    const board = await createBoard(projectRoot, {
      title: 'Confirm shell',
      boundary: {
        enabled: true,
        enforcement: 'block',
        shellAccess: 'confirm',
        allow: [{ kind: 'directory', path: 'src', access: 'write' }],
      },
    });
    const task = (await addTask(projectRoot, board.id, { title: 'Scoped shell' }))!.task;
    const execute = vi.fn(async () => ({ ok: true }));
    const tool = {
      name: 'bash',
      permission: 'auto',
      mutating: true,
      riskTier: 'destructive',
      capabilities: ['shell.arbitrary'],
      inputSchema: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
      execute,
    } as unknown as Tool;
    const events = new EventBus();
    const decisions: EventMap['permission.evaluated'][] = [];
    events.on('permission.evaluated', (event) => decisions.push(event));
    const confirmAwaiter = vi.fn().mockResolvedValue('yes');
    const executor = new ToolExecutor(
      { get: (name) => (name === tool.name ? tool : undefined), list: () => [tool] },
      {
        permissionPolicy: {
          evaluate: async () => ({ permission: 'auto', source: 'yolo' }),
        },
        secretScrubber: { scrub: (value: string) => value },
        events,
        confirmAwaiter,
      } as never,
    );
    const ctx = {
      projectRoot,
      workingDir: projectRoot,
      currentKanbanBoardId: board.id,
      currentKanbanTaskId: task.id,
      meta: {},
      signal: new AbortController().signal,
      session: { id: 'boundary-confirm-test' },
      agentId: 'worker',
      agentName: 'Worker',
      provider: { id: 'test' },
      model: 'test-model',
    } as Context;

    await executor.executeBatch(
      [
        {
          type: 'tool_use',
          id: 'shell-confirm',
          name: 'bash',
          input: { command: 'pnpm test' },
        },
      ],
      ctx,
      'sequential',
    );

    expect(decisions[0]).toMatchObject({
      policyDecision: 'auto',
      effectiveDecision: 'confirm',
      decisionSource: 'yolo',
      boundaryDecision: 'confirm',
      capabilityDowngraded: false,
    });
    expect(decisions[0]?.boundaryReason).toBeTruthy();
    expect(confirmAwaiter).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  describe('lease ownership check', () => {
    it('blocks write tools when the subagent lease mismatches the board assignment', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-lease-'));
      roots.push(projectRoot);
      const board = await createBoard(projectRoot, {
        title: 'Lease scope',
        boundary: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'block',
          allow: [{ kind: 'directory', path: 'src', access: 'write' }],
        },
      });
      const taskResult = await addTask(projectRoot, board.id, { title: 'Scoped lease' });
      const task = taskResult!.task;
      const workerLeaseId = 'worker-lease-001';
      const boardLeaseId = 'board-lease-002'; // deliberately different
      await assignTask(projectRoot, board.id, task.id, { leaseId: boardLeaseId });
      const ctx = {
        projectRoot,
        workingDir: projectRoot,
        meta: {
          kanban: {
            boardId: board.id,
            taskId: task.id,
            projectRoot,
            leaseId: workerLeaseId,
          },
        },
      } as unknown as Context;
      const writeTool = { name: 'write', capabilities: ['fs.write'] } as unknown as Tool;

      const result = await evaluateToolKanbanBoundary(
        writeTool,
        { path: 'src/test.ts' },
        ctx,
      );
      expect(result.decision).toBe('block');
      expect(result.reason).toContain('lease mismatch');
      expect(result.reason).toContain(workerLeaseId);
      expect(result.reason).toContain(boardLeaseId);
      expect(result).toMatchObject({ boardId: board.id, taskId: task.id });
    });

    it('allows write tools when the subagent lease matches the board assignment', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-lease-match-'));
      roots.push(projectRoot);
      const board = await createBoard(projectRoot, {
        title: 'Lease match',
        boundary: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'block',
          allow: [{ kind: 'directory', path: 'src', access: 'write' }],
        },
      });
      const taskResult = await addTask(projectRoot, board.id, { title: 'Match lease' });
      const task = taskResult!.task;
      const leaseId = 'lease-match-001';
      await assignTask(projectRoot, board.id, task.id, { leaseId });
      const ctx = {
        projectRoot,
        workingDir: projectRoot,
        meta: {
          kanban: {
            boardId: board.id,
            taskId: task.id,
            projectRoot,
            leaseId,
          },
        },
      } as unknown as Context;
      const writeTool = { name: 'write', capabilities: ['fs.write'] } as unknown as Tool;

      const result = await evaluateToolKanbanBoundary(
        writeTool,
        { path: 'src/test.ts' },
        ctx,
      );
      // Lease matches — the boundary allow rule governs
      expect(result.decision).toBe('allow');
    });

    it('exempts the kanban tool from lease mismatch checks', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-kanban-exempt-'));
      roots.push(projectRoot);
      const board = await createBoard(projectRoot, {
        title: 'Kanban exempt',
        boundary: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'allow', // opaque tools pass through
          allow: [{ kind: 'directory', path: 'src', access: 'write' }],
        },
      });
      const taskResult = await addTask(projectRoot, board.id, { title: 'Kanban exempt task' });
      const task = taskResult!.task;
      await assignTask(projectRoot, board.id, task.id, { leaseId: 'board-lease' });
      const ctx = {
        projectRoot,
        workingDir: projectRoot,
        meta: {
          kanban: {
            boardId: board.id,
            taskId: task.id,
            projectRoot,
            leaseId: 'stale-worker-lease', // deliberately different
          },
        },
      } as unknown as Context;
      const kanbanTool = { name: 'kanban', capabilities: ['fs.write'] } as unknown as Tool;

      const result = await evaluateToolKanbanBoundary(
        kanbanTool,
        { action: 'get_board', boardId: board.id },
        ctx,
      );
      // Kanban tool name matches the exemption — lease check is skipped,
      // and shellAccess: 'allow' lets the opaque evaluation pass.
      expect(result.decision).toBe('allow');
    });

    it('skips lease check when no leaseId is present in context', async () => {
      const projectRoot = await mkdtemp(join(tmpdir(), 'wstack-boundary-no-lease-'));
      roots.push(projectRoot);
      const board = await createBoard(projectRoot, {
        title: 'No lease',
        boundary: {
          enabled: true,
          enforcement: 'block',
          shellAccess: 'block',
          allow: [{ kind: 'directory', path: 'src', access: 'write' }],
        },
      });
      const taskResult = await addTask(projectRoot, board.id, { title: 'No lease task' });
      const task = taskResult!.task;
      await assignTask(projectRoot, board.id, task.id, { leaseId: 'board-lease' });
      const ctx = {
        projectRoot,
        workingDir: projectRoot,
        currentKanbanBoardId: board.id,
        currentKanbanTaskId: task.id,
        meta: {},
      } as unknown as Context;
      const writeTool = { name: 'write', capabilities: ['fs.write'] } as unknown as Tool;

      const result = await evaluateToolKanbanBoundary(
        writeTool,
        { path: 'src/test.ts' },
        ctx,
      );
      // No leaseId in ctx.meta.kanban → identity.leaseId is undefined
      // → lease check is skipped → boundary layers govern
      expect(result.decision).toBe('allow');
    });
  });
});
