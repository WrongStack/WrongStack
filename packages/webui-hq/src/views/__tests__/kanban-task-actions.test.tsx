// @vitest-environment jsdom
/**
 * Desktop Kanban actions issue the same lifecycle-gated commands as the phone.
 * The desktop inspector used to be read-only while mobile could move, assign
 * and dispatch — the operator's primary screen was the less capable one.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../data/api.js', () => ({
  postCommand: vi.fn(async () => ({ commandId: 'cmd-1', queued: true })),
}));

import { postCommand } from '../../data/api.js';
import { useHqStore } from '../../data/store/index.js';
import { KanbanTaskActions } from '../kanban/task-actions.js';

const task = {
  id: 'task-1',
  title: 'Ship it',
  status: 'ready',
  lifecycleStage: 'todo',
  priority: 'normal',
  columnId: 'c1',
  labels: [],
  dependsOn: [],
} as never;
const board = { id: 'board-1', title: 'Board', columns: [] } as never;

function setSnapshot(capabilities: string[]): void {
  useHqStore.setState({
    snapshot: {
      clients: [{ clientId: 'client-1', projectId: 'proj', connected: true, capabilities }],
      liveSessions: [
        {
          sessionId: 's1',
          projectId: 'proj',
          hostname: 'host',
          agents: [{ id: 'agent-1', name: 'Worker', status: 'idle' }],
        },
      ],
    } as never,
  });
}

beforeEach(() => {
  vi.mocked(postCommand).mockClear();
});

afterEach(() => {
  cleanup();
});

describe('KanbanTaskActions', () => {
  it('moves, assigns and dispatches through the project client', async () => {
    setSnapshot(['control.receive', 'kanban.dispatch']);
    render(<KanbanTaskActions task={task} board={board} projectId="proj" />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: /Move/ }));
    await user.click(screen.getByRole('button', { name: /Assign/ }));
    await user.click(screen.getByRole('button', { name: /Dispatch/ }));

    await waitFor(() => expect(postCommand).toHaveBeenCalledTimes(3));
    const calls = vi.mocked(postCommand).mock.calls;
    expect(calls[0]).toEqual([
      'client-1',
      'kanban-transition',
      expect.objectContaining({ boardId: 'board-1', taskId: 'task-1', to: 'running' }),
    ]);
    expect(calls[1]).toEqual([
      'client-1',
      'kanban-assign',
      expect.objectContaining({ agentId: 'agent-1', taskId: 'task-1' }),
    ]);
    expect(calls[2]).toEqual([
      'client-1',
      'kanban-dispatch',
      expect.objectContaining({ boardId: 'board-1', taskId: 'task-1' }),
    ]);
  });

  it('stays read-only when no client of the project takes commands', () => {
    setSnapshot(['telemetry.publish']);
    render(<KanbanTaskActions task={task} board={board} projectId="proj" />);
    expect(screen.getByTestId('kanban-task-actions')).toHaveTextContent(/Read only/);
    expect(screen.queryByRole('button', { name: /Move/ })).toBeNull();
  });
});
