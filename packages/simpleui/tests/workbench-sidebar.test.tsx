// @vitest-environment jsdom

import type { KanbanWorkbenchSnapshot } from '@wrongstack/kanban';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WorklistSnapshot } from '../src/lib/worklist-store.js';
import { WorklistSidebar } from '../src/worklist-sidebar.js';

const workbench: KanbanWorkbenchSnapshot = {
  generatedAt: '2026-08-09T12:00:00.000Z',
  boardCount: 2,
  totals: { active: 1, now: 1, next: 0, blocked: 0, review: 0, failed: 0, completed: 1 },
  flow: [
    { id: 'capture', label: 'Captured', count: 0, explanation: 'Captured work.' },
    { id: 'ready', label: 'Ready', count: 0, explanation: 'Ready work.' },
    { id: 'execute', label: 'Executing', count: 1, explanation: 'Live work.' },
    { id: 'review', label: 'Review', count: 0, explanation: 'Review work.' },
    { id: 'verified', label: 'Verified', count: 1, explanation: 'Verified work.' },
  ],
  lanes: {
    now: {
      total: 1,
      omitted: 0,
      items: [
        {
          boardId: 'board-1',
          boardTitle: 'Main board',
          boardKind: 'project',
          taskId: 'task-1',
          title: 'Visible flow task',
          lane: 'now',
          status: 'in_progress',
          priority: 'high',
          updatedAt: '2026-08-09T12:00:00.000Z',
          reason: 'Live agent execution',
          source: 'managed',
        },
      ],
    },
    next: { total: 0, omitted: 0, items: [] },
    blocked: { total: 0, omitted: 0, items: [] },
    review: { total: 0, omitted: 0, items: [] },
  },
  alerts: [],
  alertTotal: 0,
  alertsOmitted: 0,
};

describe('SimpleUI Flow workbench', () => {
  it('renders the shared pipeline and lane explanation', () => {
    const snapshot: WorklistSnapshot = {
      sessionId: 'session-1',
      todos: [],
      tasks: [],
      planItems: [],
      workbench,
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <WorklistSidebar
          view="flow"
          snapshot={snapshot}
          onTodoStatusChange={vi.fn()}
          onTaskStatusChange={vi.fn()}
          onPlanStatusChange={vi.fn()}
        />,
      ),
    );

    expect(container.querySelector('[aria-label="Kanban task flow"]')).toBeTruthy();
    expect(container.textContent).toContain('Visible flow task');
    expect(container.textContent).toContain('Live agent execution');
    act(() => root.unmount());
    container.remove();
  });
});
