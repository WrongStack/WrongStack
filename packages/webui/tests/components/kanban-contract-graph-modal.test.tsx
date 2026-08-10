import { fireEvent, render, screen } from '@testing-library/react';
import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', () => ({
  Background: () => null,
  BackgroundVariant: { Dots: 'dots' },
  Controls: () => <div data-testid="flow-controls" />,
  MarkerType: { ArrowClosed: 'arrowclosed' },
  MiniMap: () => <div data-testid="flow-minimap" />,
  ReactFlow: ({ children }: { children?: ReactNode }) => (
    <div data-testid="contract-react-flow">{children}</div>
  ),
}));

import { KanbanContractGraphDashboard } from '../../src/components/KanbanContractGraphDashboard.js';
import { KanbanContractGraphPanel } from '../../src/components/KanbanContractGraphPanel.js';

const now = '2026-08-09T00:00:00.000Z';
const task: KanbanTask = {
  id: 'task-1',
  title: 'Make the map readable',
  description: 'Improve Contract Map geometry.',
  columnId: 'running',
  order: 0,
  priority: 'high',
  status: 'in_progress',
  successCriteria: [
    { id: 'check-1', description: 'Layout is readable', type: 'manual', status: 'pending' },
  ],
  goalMetrics: [{ id: 'metric-1', name: 'Readable map', status: 'pending' }],
  createdAt: now,
  updatedAt: now,
};
const board: KanbanBoard = {
  id: 'board-1',
  title: 'UX board',
  columns: [{ id: 'running', title: 'Running', order: 0 }],
  tasks: [task],
  createdAt: now,
  updatedAt: now,
  version: 1,
  contractGraph: {
    version: 1,
    enforcement: 'strict',
    updatedAt: now,
    nodes: [
      {
        id: 'objective-1',
        taskId: task.id,
        kind: 'objective',
        title: 'Readable map',
        enforcement: 'blocking',
        state: 'active',
        metricId: 'metric-1',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'verification-1',
        taskId: task.id,
        kind: 'verification',
        title: 'Visual check',
        enforcement: 'advisory',
        state: 'active',
        checkId: 'check-1',
        createdAt: now,
        updatedAt: now,
      },
    ],
    edges: [
      {
        id: 'edge-1',
        from: `task:${task.id}`,
        to: 'objective-1',
        type: 'targets',
        enforcement: 'blocking',
        createdAt: now,
      },
    ],
  },
};

describe('Kanban Contract Map expansion', () => {
  it('uses a taller embedded task canvas and opens a viewport-sized modal', () => {
    render(<KanbanContractGraphPanel board={board} task={task} />);

    const embedded = document.querySelector('[data-contract-canvas="embedded"]');
    expect(embedded?.className).toContain('h-[32rem]');
    fireEvent.click(screen.getByRole('button', { name: 'Expand Contract Map' }));

    expect(screen.getByRole('dialog').className).toContain('h-[calc(100dvh-2rem)]');
    expect(document.querySelector('[data-contract-canvas="expanded"]')).toBeTruthy();
    expect(screen.getByText(/Contract Map · Make the map readable/)).toBeTruthy();
  });

  it('opens the board-wide dependency field in the same full viewport treatment', () => {
    render(<KanbanContractGraphDashboard board={board} onSelectTask={vi.fn()} />);

    const embedded = document.querySelector('[data-contract-board-canvas="embedded"]');
    expect(embedded?.className).toContain('min-h-[680px]');
    fireEvent.click(screen.getByRole('button', { name: 'Expand board Contract Map' }));

    expect(screen.getByRole('dialog').className).toContain('max-w-[calc(100vw-2rem)]');
    expect(document.querySelector('[data-contract-board-canvas="expanded"]')).toBeTruthy();
    expect(screen.getByText(/Contract Map · UX board/)).toBeTruthy();
  });
});
