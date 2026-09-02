import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Capture every WS message the board sends.
const sent: Array<{ type: string }> = [];
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: { send: (m: { type: string }) => sent.push(m) } }),
}));
vi.mock('@/hooks/useProviderModels', () => ({ useProviderModels: () => [] }));
// Stub the heavy presentational children so the test stays focused on controls.
vi.mock('@/components/SddFlowGraph', () => ({
  SddFlowGraph: ({ onTaskClick }: { onTaskClick: (id: string) => void }) => (
    <button type="button" onClick={() => onTaskClick('task-1')}>
      Open task
    </button>
  ),
}));
vi.mock('@/components/SddKanbanView', () => ({ SddKanbanView: () => null }));
vi.mock('@/components/SddActivityFeed', () => ({ SddActivityFeed: () => null }));
vi.mock('@/components/SddTaskDrawer', () => ({
  SddTaskDrawer: ({
    expanded,
    onToggleExpanded,
  }: {
    expanded: boolean;
    onToggleExpanded: () => void;
  }) => (
    <button type="button" onClick={onToggleExpanded}>
      {expanded ? 'Collapse task detail' : 'Expand task detail'}
    </button>
  ),
}));

import { SddBoardView } from '../../src/components/SddBoardView.js';
import { useSddBoardStore, type SddBoardSnapshotUI } from '../../src/stores/sdd-board-store.js';

function snapshot(over: Partial<SddBoardSnapshotUI> = {}): SddBoardSnapshotUI {
  return {
    runId: 'r1',
    graphId: 'g1',
    title: 'My Run',
    status: 'completed', // not running/paused → lifecycle controls show
    startedAt: 0,
    updatedAt: 0,
    progress: {
      total: 1,
      completed: 1,
      failed: 0,
      inProgress: 0,
      pending: 0,
      blocked: 0,
      review: 0,
      percentComplete: 100,
    },
    wave: 0,
    tasks: [],
    columns: [],
    ...over,
  };
}

afterEach(() => {
  sent.length = 0;
  // Wrapped in act(): the component rendered during the test is still mounted
  // here (no cleanup() call), so this reset updates a live subscriber.
  act(() => {
    useSddBoardStore.setState({ snapshot: null, lifecycleResult: null, destroying: false });
  });
});

describe('SddBoardView — lifecycle controls', () => {
  it('expands the selected task panel into the wide reading layout', () => {
    act(() => {
      useSddBoardStore.setState({
        snapshot: snapshot({
          tasks: [
            {
              id: 'task-1',
              shortId: 't01',
              title: 'Build the thing',
              description: 'Long task details',
              priority: 'high',
              type: 'feature',
              status: 'pending',
              displayStatus: 'pending',
              deps: [],
            },
          ],
        }),
      });
    });
    render(<SddBoardView onClose={() => {}} />);

    fireEvent.click(screen.getByText('Open task'));
    const panel = screen.getByTestId('sdd-task-panel');
    expect(panel.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(screen.getByText('Expand task detail'));
    expect(panel.getAttribute('data-expanded')).toBe('true');
    expect(panel.className).toContain('w-[min(72rem,72vw)]');
  });

  it('Clean worktrees sends sdd.board.cleanup_worktrees when the run is stopped', () => {
    act(() => {
      useSddBoardStore.setState({ snapshot: snapshot() });
    });
    render(<SddBoardView onClose={() => {}} />);
    fireEvent.click(screen.getByText('Clean worktrees'));
    expect(sent.some((m) => m.type === 'sdd.board.cleanup_worktrees')).toBe(true);
  });

  it('Rollback shows only with merged commits and sends sdd.board.rollback', () => {
    // No merged commits → no Rollback button.
    act(() => {
      useSddBoardStore.setState({ snapshot: snapshot() });
    });
    const { rerender } = render(<SddBoardView onClose={() => {}} />);
    expect(screen.queryByText(/Rollback/)).toBeNull();

    act(() => {
      useSddBoardStore.setState({
        snapshot: snapshot({
          baseBranch: 'main',
          mergedCommits: [{ taskId: 't', sha: 'abc1234', title: 'x' }],
        }),
      });
    });
    rerender(<SddBoardView onClose={() => {}} />);
    fireEvent.click(screen.getByText(/Rollback/));
    expect(sent.some((m) => m.type === 'sdd.board.rollback')).toBe(true);
  });

  it('hides lifecycle controls while the run is active', () => {
    act(() => {
      useSddBoardStore.setState({ snapshot: snapshot({ status: 'running' }) });
    });
    render(<SddBoardView onClose={() => {}} />);
    expect(screen.queryByText('Clean worktrees')).toBeNull();
  });

  it('Destroy opens a confirm dialog and sends sdd.board.destroy when stopped', () => {
    act(() => {
      useSddBoardStore.setState({ snapshot: snapshot() });
    });
    render(<SddBoardView onClose={() => {}} />);
    fireEvent.click(screen.getByText('Destroy'));
    // The confirmation dialog appears, then confirm fires the wipe immediately
    // (run is already stopped).
    fireEvent.click(screen.getByText('Destroy everything'));
    expect(sent.some((m) => m.type === 'sdd.board.destroy')).toBe(true);
  });

  it('Destroy on an active run sends stop first (not destroy yet)', () => {
    act(() => {
      useSddBoardStore.setState({ snapshot: snapshot({ status: 'running' }) });
    });
    render(<SddBoardView onClose={() => {}} />);
    fireEvent.click(screen.getByText('Destroy'));
    fireEvent.click(screen.getByText('Destroy everything'));
    expect(sent.some((m) => m.type === 'sdd.board.stop')).toBe(true);
    expect(sent.some((m) => m.type === 'sdd.board.destroy')).toBe(false);
    expect(useSddBoardStore.getState().destroying).toBe(true);
  });

  it('renders a result banner from a lifecycle_result', () => {
    act(() => {
      useSddBoardStore.setState({
        snapshot: snapshot(),
        lifecycleResult: { op: 'cleanup_worktrees', ok: true, removed: 3, at: 1 },
      });
    });
    render(<SddBoardView onClose={() => {}} />);
    expect(screen.getByText(/3 worktrees removed/)).toBeTruthy();
  });
});
