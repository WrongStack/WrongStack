import { fireEvent, render, screen } from '@testing-library/react';
import type { KanbanWorkbenchSnapshot } from '@wrongstack/kanban';
import { describe, expect, it, vi } from 'vitest';
import { KanbanWorkbench } from '../../src/components/KanbanWorkbench.js';

const snapshot: KanbanWorkbenchSnapshot = {
  generatedAt: '2026-08-09T12:00:00.000Z',
  boardCount: 2,
  totals: { active: 2, now: 1, next: 0, blocked: 1, review: 0, failed: 0, completed: 3 },
  flow: [
    { id: 'capture', label: 'Captured', count: 1, explanation: 'Recorded.' },
    { id: 'ready', label: 'Ready', count: 0, explanation: 'Ready.' },
    { id: 'execute', label: 'Executing', count: 1, explanation: 'Executing.' },
    { id: 'review', label: 'Review', count: 0, explanation: 'Review.' },
    { id: 'verified', label: 'Verified', count: 3, explanation: 'Verified.' },
  ],
  lanes: {
    now: {
      total: 1,
      omitted: 0,
      items: [
        {
          boardId: 'board-1',
          boardTitle: 'Release board',
          boardKind: 'project',
          taskId: 'task-1',
          title: 'Ship release',
          lane: 'now',
          status: 'in_progress',
          priority: 'critical',
          updatedAt: '2026-08-09T12:00:00.000Z',
          reason: 'Live agent execution',
          source: 'managed',
        },
      ],
    },
    next: { total: 0, omitted: 0, items: [] },
    blocked: { total: 1, omitted: 1, items: [] },
    review: { total: 0, omitted: 0, items: [] },
  },
  alerts: [
    {
      id: 'stale:board-1:task-1',
      severity: 'critical',
      kind: 'stale_running',
      title: 'Stale execution lease',
      detail: 'The execution lease expired.',
      boardId: 'board-1',
      taskId: 'task-1',
    },
  ],
  alertTotal: 1,
  alertsOmitted: 0,
};

describe('KanbanWorkbench', () => {
  it('offers a visible retry when the projection has not loaded', () => {
    const onRetry = vi.fn();
    render(
      <KanbanWorkbench snapshot={null} loading={false} onRetry={onRetry} onSelectTask={vi.fn()} />,
    );

    expect(screen.getByText('Project workbench has not been loaded yet.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry workbench' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows flow, bounded lanes, source identity, and navigable alerts', () => {
    const onSelectTask = vi.fn();
    render(
      <KanbanWorkbench
        snapshot={snapshot}
        loading={false}
        onRetry={vi.fn()}
        onSelectTask={onSelectTask}
      />,
    );

    expect(screen.getByText('One truthful view of every active board')).toBeTruthy();
    expect(screen.getByText('Ship release')).toBeTruthy();
    expect(screen.getByText('managed')).toBeTruthy();
    expect(screen.getByText('+1 more cards hidden to keep focus')).toBeTruthy();
    fireEvent.click(screen.getByText('Stale execution lease'));
    expect(onSelectTask).toHaveBeenCalledWith('board-1', 'task-1');
  });
});
