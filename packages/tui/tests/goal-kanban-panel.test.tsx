import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GoalSummary } from '../src/app-state.js';
import { GoalKanbanPanel } from '../src/components/goal-kanban-panel.js';

const mocks = vi.hoisted(() => ({
  getBoard: vi.fn(),
  listBoards: vi.fn(),
}));

vi.mock('@wrongstack/kanban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/kanban')>();
  return { ...actual, getBoard: mocks.getBoard, listBoards: mocks.listBoards };
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
const NOW = '2026-07-30T00:00:00.000Z';

function task(id: string, status: KanbanTask['status'], columnId: string): KanbanTask {
  return {
    id,
    title: `Task ${id}`,
    columnId,
    order: 0,
    priority: 'medium',
    status,
    assignedAgent: status === 'in_progress' ? 'worker' : undefined,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function board(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: 'goal-board',
    title: '🎯 Coverage',
    tags: [' goal:cover-everything '],
    columns: [
      { id: 'todo', title: 'Backlog', order: 0 },
      { id: 'doing', title: 'In Progress', order: 1 },
      { id: 'done', title: 'Done', order: 2 },
    ],
    tasks: [
      task('pending', 'pending', 'todo'),
      task('active', 'in_progress', 'doing'),
      task('blocked', 'blocked', 'doing'),
      task('done', 'completed', 'done'),
    ],
    createdAt: NOW,
    updatedAt: NOW,
    version: 1,
    ...overrides,
  };
}

function goal(
  overrides: Exclude<GoalSummary, null> = {
    goal: 'Cover everything',
    goalState: 'active',
    iterations: 2,
  },
): Exclude<GoalSummary, null> {
  return overrides;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('GoalKanbanPanel', () => {
  it('loads the exact normalized goal tag and renders sorted columns and task states', async () => {
    const exact = board();
    mocks.listBoards.mockResolvedValue([
      board({ id: 'prefix', tags: ['goal:cover-everything-else'] }),
      exact,
    ]);
    mocks.getBoard.mockResolvedValue(exact);

    const view = render(
      React.createElement(GoalKanbanPanel, {
        projectRoot: 'D:/repo',
        goal: goal({
          goal: 'Cover everything',
          refinedGoal: 'Cover everything',
          goalState: 'active',
          iterations: 2,
          progress: 50,
          progressTrend: 'accelerating',
          progressNote: 'Halfway',
          deliverables: ['[x] tests', '[ ] scripts'],
        }),
        onClose: vi.fn(),
      }),
    );
    await flush();

    const frame = view.lastFrame() ?? '';
    expect(mocks.getBoard).toHaveBeenCalledWith('D:/repo', 'goal-board');
    expect(frame).toContain('GOAL KANBAN');
    expect(frame).toContain('50%');
    expect(frame).toContain('Halfway');
    expect(frame).toContain('Backlog');
    expect(frame).toContain('In Progress');
    expect(frame).toContain('Task acti');
    expect(frame).toContain('@worker');
    expect(frame).toContain('1 pending');
    expect(frame).toContain('1 active');
    expect(frame).toContain('1 blocked');
    expect(frame).toContain('1 done');
    view.unmount();
  });

  it('uses the titled fallback board and closes on q', async () => {
    const fallback = board({ id: 'fallback', tags: [] });
    mocks.listBoards.mockResolvedValue([fallback]);
    mocks.getBoard.mockResolvedValue(fallback);
    const onClose = vi.fn();
    const view = render(
      React.createElement(GoalKanbanPanel, {
        projectRoot: 'D:/repo',
        goal: goal(),
        onClose,
      }),
    );
    await flush();
    view.stdin.write('q');
    await flush();

    expect(mocks.getBoard).toHaveBeenCalledWith('D:/repo', 'fallback');
    expect(onClose).toHaveBeenCalledOnce();
    view.unmount();
  });

  it('renders empty and error states without inventing a board', async () => {
    mocks.listBoards.mockResolvedValueOnce([]);
    const empty = render(
      React.createElement(GoalKanbanPanel, {
        projectRoot: 'D:/repo',
        goal: goal(),
        onClose: vi.fn(),
      }),
    );
    await flush();
    expect(empty.lastFrame() ?? '').toContain('Goal kanban board not yet created');
    empty.unmount();

    mocks.listBoards.mockRejectedValueOnce('storage unavailable');
    const failed = render(
      React.createElement(GoalKanbanPanel, {
        projectRoot: 'D:/repo',
        goal: null,
        onClose: vi.fn(),
      }),
    );
    await flush();
    expect(failed.lastFrame() ?? '').toContain('Error: storage unavailable');
    failed.unmount();
  });
});
