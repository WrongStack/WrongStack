import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { KanbanTaskTree } from '../../src/components/KanbanTaskTree.js';
import { KanbanVerificationDashboard } from '../../src/components/KanbanVerificationDashboard.js';
import { KanbanDecompositionApprovalCard } from '../../src/components/KanbanDecompositionPanel.js';

const now = '2026-07-24T00:00:00.000Z';

function task(id: string, overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id,
    title: `Task ${id}`,
    columnId: 'backlog',
    order: 0,
    priority: 'medium',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as KanbanTask;
}

function board(tasks: KanbanTask[]): KanbanBoard {
  return {
    id: 'b1',
    title: 'Board',
    columns: [{ id: 'backlog', title: 'Backlog', order: 0 }],
    tasks,
    createdAt: now,
    updatedAt: now,
    version: 1,
  } as KanbanBoard;
}

function passedReport(taskId: string) {
  return {
    taskId,
    taskTitle: `Task ${taskId}`,
    boardId: 'b1',
    startedAt: now,
    completedAt: now,
    verdict: 'passed' as const,
    checks: [],
    markdownSummary: '',
    attachments: [],
  };
}

describe('KanbanTaskTree', () => {
  it('renders the hierarchy with verification chips and selects on click', () => {
    const onSelectTask = vi.fn();
    render(
      <KanbanTaskTree
        board={board([
          task('parent', {
            childTaskIds: ['child'],
            atomic: true,
            verificationReport: passedReport('parent'),
          }),
          task('child', { parentTaskId: 'parent', status: 'completed' }),
        ])}
        selectedTaskId={null}
        onSelectTask={onSelectTask}
      />,
    );
    expect(screen.getByText('Task parent')).toBeTruthy();
    expect(screen.getByText('Task child')).toBeTruthy();
    expect(screen.getByText('verified')).toBeTruthy();
    expect(screen.getAllByText('unverified')).toHaveLength(1);
    expect(screen.getByText('atomic')).toBeTruthy();

    fireEvent.click(screen.getByText('Task child'));
    expect(onSelectTask).toHaveBeenCalledWith('child');
  });
});

describe('KanbanVerificationDashboard', () => {
  it('summarizes DoD state and clicks through failing checks', () => {
    const onSelectTask = vi.fn();
    render(
      <KanbanVerificationDashboard
        board={board([
          task('ok', { status: 'completed', verificationReport: passedReport('ok') }),
          task('bad', {
            status: 'review',
            verificationReport: {
              ...passedReport('bad'),
              verdict: 'failed',
              checks: [
                {
                  checkId: 'c1',
                  description: 'tests pass',
                  type: 'test',
                  status: 'failed',
                  evidence: {},
                },
              ],
            },
          }),
          task('big', {
            atomicityAssessment: {
              verdict: 'needs_decomposition',
              score: 0.3,
              criteria: [],
              assessedAt: now,
              assessedBy: 'rules',
            },
          }),
        ])}
        onSelectTask={onSelectTask}
      />,
    );
    expect(screen.getByText('Definition of Done')).toBeTruthy();
    expect(screen.getByText('Failing checks')).toBeTruthy();
    expect(screen.getByText('Needs decomposition')).toBeTruthy();

    fireEvent.click(screen.getByText('tests pass'));
    expect(onSelectTask).toHaveBeenCalledWith('bad');
  });
});

describe('KanbanDecompositionApprovalCard', () => {
  it('lists pending proposals and sends approve/reject actions', () => {
    const sendKanban = vi.fn();
    const proposalTask = task('p1', {
      decomposition: {
        id: 'prop-1',
        taskId: 'p1',
        status: 'proposed',
        mode: 'approval',
        proposedSubtasks: [
          { title: 'A', description: 'a' },
          { title: 'B', description: 'b' },
        ],
        proposedAt: now,
      },
    });
    render(
      <KanbanDecompositionApprovalCard
        board={board([proposalTask])}
        sendKanban={sendKanban}
        onSelectTask={vi.fn()}
      />,
    );
    expect(screen.getByText(/1 decomposition proposal/)).toBeTruthy();

    fireEvent.click(screen.getByText('Approve'));
    expect(sendKanban).toHaveBeenCalledWith('kanban.decomposition.approve', {
      boardId: 'b1',
      taskId: 'p1',
      proposalId: 'prop-1',
    });
    fireEvent.click(screen.getByText('Reject'));
    expect(sendKanban).toHaveBeenCalledWith('kanban.decomposition.reject', {
      boardId: 'b1',
      taskId: 'p1',
      proposalId: 'prop-1',
    });
  });

  it('renders nothing when no proposals are pending', () => {
    const { container } = render(
      <KanbanDecompositionApprovalCard
        board={board([task('plain')])}
        sendKanban={vi.fn()}
        onSelectTask={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
