import { describe, expect, it, vi } from 'vitest';

vi.mock('@wrongstack/kanban', () => ({
  getBoard: vi.fn().mockResolvedValue({
    id: 'board-1',
    title: 'Test Board',
    tasks: [
      {
        id: 'task-1',
        title: 'Parent Task',
        columnId: 'todo',
        order: 0,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    columns: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
  }),
  splitTask: vi.fn().mockResolvedValue({
    board: {
      id: 'board-1',
      title: 'Test Board',
      tasks: [
        {
          id: 'task-1',
          title: 'Parent Task',
          columnId: 'todo',
          order: 0,
          priority: 'medium',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      columns: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    },
    parent: {
      id: 'task-1',
      title: 'Parent Task',
      columnId: 'todo',
      order: 0,
      priority: 'medium',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    children: [
      {
        id: 'child-1',
        title: 'Child 1',
        columnId: 'todo',
        order: 1,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  }),
}));

import { handleSplitTask, requireBoard } from '../src/kanban-split-task-handler.js';

/** Session that owns the board events a split writes. */
const SPLIT_EVENT_CONTEXT = { sessionId: '2026-08-26/sess_01TESTSPLITHANDLER000000' };

describe('handleSplitTask', () => {
  it('fails when required params missing', async () => {
    const result = await handleSplitTask('/project', { action: 'split_task' }, {}, SPLIT_EVENT_CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(
      'split requires boardId, taskId, and at least one childTitles',
    );
  });

  it('splits task with child titles', async () => {
    const { splitTask } = await import('@wrongstack/kanban');
    vi.mocked(splitTask).mockResolvedValueOnce({
      board: {
        id: 'board-1',
        title: 'Test Board',
        tasks: [
          {
            id: 't1',
            title: 'Parent Task',
            columnId: 'todo',
            order: 0,
            priority: 'medium',
            status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        columns: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      parent: {
        id: 't1',
        title: 'Parent Task',
        columnId: 'todo',
        order: 0,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      children: [
        {
          id: 'child-1',
          title: 'Child 1',
          columnId: 'todo',
          order: 1,
          priority: 'medium',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const result = await handleSplitTask(
      '/project',
      { action: 'split_task', boardId: 'b1', taskId: 't1', childTitles: ['Child 1'] },
      {},
      SPLIT_EVENT_CONTEXT,
    );
    expect(result.ok).toBe(true);
    expect(result.message).toContain('child task(s) created');
  });

  it('fails when task not found in result', async () => {
    const { splitTask } = await import('@wrongstack/kanban');
    vi.mocked(splitTask).mockResolvedValueOnce({
      board: {
        id: 'board-1',
        title: 'Empty Board',
        tasks: [], // No parent task
        columns: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      parent: {
        id: 't1',
        title: 'Parent Task',
        columnId: 'todo',
        order: 0,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      children: [
        {
          id: 'child-1',
          title: 'Child 1',
          columnId: 'todo',
          order: 1,
          priority: 'medium',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const result = await handleSplitTask(
      '/project',
      { action: 'split_task', boardId: 'b1', taskId: 't1', childTitles: ['Child 1'] },
      {},
      SPLIT_EVENT_CONTEXT,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('not found in returned board');
  });

  it('fails when splitTask returns null', async () => {
    const { splitTask } = await import('@wrongstack/kanban');
    vi.mocked(splitTask).mockResolvedValueOnce(null);
    const result = await handleSplitTask(
      '/project',
      { action: 'split_task', boardId: 'b1', taskId: 't1', childTitles: ['Child 1'] },
      {},
      SPLIT_EVENT_CONTEXT,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Task not found');
  });

  it('passes extra split options like atomic', async () => {
    const { splitTask } = await import('@wrongstack/kanban');
    vi.mocked(splitTask).mockResolvedValueOnce({
      board: {
        id: 'board-1',
        title: 'Test Board',
        tasks: [
          {
            id: 't1',
            title: 'Parent Task',
            columnId: 'todo',
            order: 0,
            priority: 'medium',
            status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        columns: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      parent: {
        id: 't1',
        title: 'Parent Task',
        columnId: 'todo',
        order: 0,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      children: [
        {
          id: 'child-1',
          title: 'Child 1',
          columnId: 'todo',
          order: 1,
          priority: 'medium',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const result = await handleSplitTask(
      '/project',
      { action: 'split_atomic', boardId: 'b1', taskId: 't1', childTitles: ['Child 1'] },
      { atomic: true },
      SPLIT_EVENT_CONTEXT,
    );
    expect(result.ok).toBe(true);
  });

  it('passes optional fields to splitTask', async () => {
    const { splitTask } = await import('@wrongstack/kanban');
    vi.mocked(splitTask).mockResolvedValueOnce({
      board: {
        id: 'board-1',
        title: 'Test Board',
        tasks: [
          {
            id: 't1',
            title: 'Parent Task',
            columnId: 'todo',
            order: 0,
            priority: 'medium',
            status: 'pending',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        columns: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      },
      parent: {
        id: 't1',
        title: 'Parent Task',
        columnId: 'todo',
        order: 0,
        priority: 'medium',
        status: 'pending',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      children: [
        {
          id: 'child-1',
          title: 'Child 1',
          columnId: 'todo',
          order: 1,
          priority: 'medium',
          status: 'pending',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const result = await handleSplitTask(
      '/project',
      {
        action: 'split_task',
        boardId: 'b1',
        taskId: 't1',
        childTitles: ['Child 1'],
        targetColumnId: 'col-2',
        inheritAssignment: true,
        inheritLabels: true,
        inheritSuccessCriteria: true,
        inheritGoalMetrics: true,
        inheritDependencies: true,
        chainChildren: true,
        rewireDependents: true,
      },
      {},
      SPLIT_EVENT_CONTEXT,
    );
    expect(result.ok).toBe(true);
  });
});

describe('requireBoard', () => {
  it('returns board when boardId provided', async () => {
    const board = await requireBoard('/project', 'b1');
    expect(board).toBeDefined();
    expect(board?.id).toBe('board-1');
  });

  it('returns null when boardId undefined', async () => {
    const board = await requireBoard('/project', undefined);
    expect(board).toBeNull();
  });
});
