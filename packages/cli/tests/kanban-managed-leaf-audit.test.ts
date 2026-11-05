import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { createManagedLifecyclePolicy, validateManagedTaskTransition } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { auditKanbanBoard as auditWebui } from '../../project-surfaces/src/kanban/kanban-cleaner.js';
import { auditKanbanBoard as auditTui } from '../../tui/src/kanban-audit.js';

const at = '2026-10-03T12:00:00Z';
function fixture(atomic: boolean): { board: KanbanBoard; task: KanbanTask } {
  const task: KanbanTask = {
    id: 'leaf',
    title: 'Accepted unit of work',
    description: 'A single verifiable file change.',
    status: 'review',
    columnId: 'review',
    order: 0,
    priority: 'medium',
    assignee: 'worker',
    labels: ['unit'],
    atomic,
    childTaskIds: [],
    createdAt: at,
    updatedAt: at,
    lifecycle: { currentStage: 'review', stageEnteredAt: at, history: [] },
    assignment: { status: 'completed', lastResult: 'Implementation complete' },
    successCriteria: [
      { id: 'review', type: 'manual', description: 'Reviewer approved', status: 'passed' },
    ],
  };
  return {
    task,
    board: {
      id: 'board',
      title: 'Board',
      version: 1,
      createdAt: at,
      updatedAt: at,
      tasks: [task],
      columns: ['backlog', 'todo', 'in-progress', 'review', 'done'].map((id, order) => ({
        id,
        title: id,
        order,
      })),
      lifecycle: createManagedLifecyclePolicy(),
    },
  };
}
describe.each([
  ['TUI', auditTui],
  ['WebUI', auditWebui],
] as const)('%s managed child requirements', (_name, audit) => {
  it('does not tell a valid executable leaf to create child tasks', () => {
    const { board, task } = fixture(false);
    expect(
      validateManagedTaskTransition(board, task, {
        to: 'done',
        actor: 'reviewer',
        action: 'Accepted',
        comment: 'Current work accepted',
      }),
    ).toEqual([]);
    expect(
      audit(board, { now: Date.parse(at) }).issues.some(
        (issue) => issue.code === 'missing-subtasks',
      ),
    ).toBe(false);
  });
  it('continues to warn about a composite parent with no children', () => {
    const { board } = fixture(true);
    expect(
      audit(board, { now: Date.parse(at) }).issues.some(
        (issue) => issue.code === 'missing-subtasks',
      ),
    ).toBe(true);
  });
  it('retains the legacy advisory for missing task decomposition', () => {
    const { board } = fixture(false);
    delete board.lifecycle;
    expect(
      audit(board, { now: Date.parse(at) }).issues.some(
        (issue) => issue.code === 'missing-subtasks',
      ),
    ).toBe(true);
  });
});
