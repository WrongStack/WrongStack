import { describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted, so factories must use inline definitions (no top-level variable refs)
vi.mock('@wrongstack/kanban', () => {
  const board = {
    id: 'board-1',
    title: 'Test Board',
    tasks: [],
    columns: [],
    metadata: {},
  };
  return {
    addDependency: vi.fn().mockResolvedValue(board),
    addGoalMetricToTask: vi.fn().mockResolvedValue(board),
    updateGoalMetricOnTask: vi.fn().mockResolvedValue(board),
    addCheckToTask: vi.fn().mockResolvedValue(board),
    updateCheckOnTask: vi.fn().mockResolvedValue(board),
    addNoteToTask: vi.fn().mockResolvedValue(board),
    addLinkToTask: vi.fn().mockResolvedValue(board),
    getContractGraph: vi.fn().mockResolvedValue({
      board,
      graph: { version: 1, enforcement: 'strict', nodes: [], edges: [], updatedAt: 'now' },
    }),
    configureContractGraph: vi.fn().mockResolvedValue(board),
    upsertContractNode: vi.fn().mockResolvedValue({
      board,
      node: { id: 'node-1', title: 'Objective' },
    }),
    addContractEdge: vi.fn().mockResolvedValue({ board, edge: { id: 'edge-1' } }),
    removeContractNode: vi.fn().mockResolvedValue(board),
    removeContractEdge: vi.fn().mockResolvedValue(board),
    evaluateTaskContractGraph: vi.fn().mockResolvedValue({
      board,
      evaluation: {
        taskId: 't1',
        enforcement: 'strict',
        allowed: true,
        evaluatedNodeIds: [],
        issues: [],
      },
    }),
    getBoard: vi.fn().mockResolvedValue(board),
    splitTask: vi.fn().mockResolvedValue({ board, children: [] }),
  };
});

vi.mock('../src/kanban-split-task-handler.js', () => {
  return {
    handleSplitTask: vi.fn().mockResolvedValue({
      ok: true,
      message: '1 child task(s) created.',
      board: { id: 'board-1', title: 'Test', tasks: [], columns: [], metadata: {} },
      task: { id: 'task-1', title: 'Test Task' },
      children: [],
    }),
  };
});

import { handleKanbanDetailAction } from '../src/kanban-detail-actions.js';

describe('handleKanbanDetailAction', () => {
  const projectRoot = '/fake/project';
  const ctx = {
    eventSessionId: () => '2026-08-26/sess_TESTDETAIL',
  } as unknown as import('@wrongstack/core/agent').Context;
  const run = (input: Parameters<typeof handleKanbanDetailAction>[1]) =>
    handleKanbanDetailAction(projectRoot, input, ctx);

  it('returns undefined for unknown action', async () => {
    const result = await run({
      action: 'list_boards' as never,
    });
    expect(result).toBeUndefined();
  });

  describe('add_dependency', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'add_dependency',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and dependencyTaskId');
    });

    it('adds a dependency with valid params', async () => {
      const result = await run({
        action: 'add_dependency',
        boardId: 'b1',
        taskId: 't1',
        dependencyTaskId: 't2',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Dependency added');
    });

    it('fails when task not found', async () => {
      const { addDependency } = await import('@wrongstack/kanban');
      vi.mocked(addDependency).mockResolvedValueOnce(null);
      const result = await run({
        action: 'add_dependency',
        boardId: 'b1',
        taskId: 't1',
        dependencyTaskId: 't2',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('Task not found');
    });
  });

  describe('add_goal_metric', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'add_goal_metric',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and metricName');
    });

    it('adds a goal metric with optional fields', async () => {
      const result = await run({
        action: 'add_goal_metric',
        boardId: 'b1',
        taskId: 't1',
        metricName: 'Speed',
        metricStatus: 'pending',
        metricTarget: '100',
        metricCurrent: '50',
        metricUnit: '%',
        metricNotes: 'Improving',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Goal metric added');
    });
  });

  describe('update_goal_metric', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'update_goal_metric',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and metricId');
    });

    it('updates goal metric with all fields', async () => {
      const result = await run({
        action: 'update_goal_metric',
        boardId: 'b1',
        taskId: 't1',
        metricId: 'm1',
        metricName: 'Quality',
        metricStatus: 'missed',
        metricTarget: '95',
        metricCurrent: '80',
        metricUnit: '%',
        metricNotes: 'Needs work',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Goal metric updated');
    });
  });

  describe('add_check', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'add_check',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and checkDescription');
    });

    it('adds a check with description and status', async () => {
      const result = await run({
        action: 'add_check',
        boardId: 'b1',
        taskId: 't1',
        checkDescription: 'Verify output',
        checkStatus: 'passed',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Check added');
    });
  });

  describe('update_check', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'update_check',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and checkId');
    });

    it('updates check description and status', async () => {
      const result = await run({
        action: 'update_check',
        boardId: 'b1',
        taskId: 't1',
        checkId: 'c1',
        checkDescription: 'Updated desc',
        checkStatus: 'failed',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Check updated');
    });
  });

  describe('add_note', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'add_note',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and note');
    });

    it('adds a note with author', async () => {
      const result = await run({
        action: 'add_note',
        boardId: 'b1',
        taskId: 't1',
        note: 'Some note',
        author: 'tester',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Note added');
    });
  });

  describe('add_link', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'add_link',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and url');
    });

    it('adds a link with title', async () => {
      const result = await run({
        action: 'add_link',
        boardId: 'b1',
        taskId: 't1',
        url: 'https://example.com',
        linkTitle: 'Example',
        linkType: 'url',
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toContain('Link added');
    });
  });

  describe('split_atomic', () => {
    it('fails when required params missing', async () => {
      const result = await run({
        action: 'split_atomic',
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toContain('requires boardId, taskId, and childTitles');
    });

    it('splits a task with atomic flag', async () => {
      const result = await run({
        action: 'split_atomic',
        boardId: 'b1',
        taskId: 't1',
        childTitles: ['Subtask 1'],
      });
      expect(result?.ok).toBe(true);
    });
  });
});
