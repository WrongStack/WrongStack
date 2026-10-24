import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { WorktreeTimelineEvent } from '@wrongstack/contracts/types/worktree-timeline';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeTimelineView } from '../../src/components/WorktreeTimeline.js';
import {
  handleWorktreeTimeline,
  handleWorktreeTimelineEvent,
} from '../../src/hooks/ws-handlers/fleet-handlers.js';
import { useWorktreeStore } from '../../src/stores/index.js';

const sendMock = vi.fn();
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: { send: sendMock } }),
}));
const confirmMock = vi.fn(async () => true);
vi.mock('@/components/ConfirmModal', () => ({
  confirmModal: (...args: unknown[]) => confirmMock(...(args as [])),
}));

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0);
const DIR = '/proj/.wrongstack/worktrees';

function lifecycle(): WorktreeTimelineEvent[] {
  const api = { handleId: 'api-1', ownerId: 'p1', branch: 'wstack/ap/api-1', sessionId: 's1' };
  const db = { handleId: 'db-2', ownerId: 'p2', branch: 'wstack/ap/db-2', sessionId: 's1' };
  const other = { handleId: 'ui-3', ownerId: 'p3', branch: 'wstack/ap/ui-3', sessionId: 's2' };
  return [
    {
      kind: 'allocated',
      at: T0,
      ...api,
      ownerLabel: 'API phase',
      baseBranch: 'main',
      dir: `${DIR}/api-1`,
    },
    {
      kind: 'allocated',
      at: T0 + 1000,
      ...db,
      ownerLabel: 'DB phase',
      baseBranch: 'main',
      dir: `${DIR}/db-2`,
    },
    {
      kind: 'committed',
      at: T0 + 30_000,
      ...api,
      committed: true,
      insertions: 12,
      deletions: 3,
      files: 2,
      sha: 'abcdef123',
    },
    { kind: 'merging', at: T0 + 40_000, ...api, baseBranch: 'main' },
    { kind: 'merged', at: T0 + 41_000, ...api, baseBranch: 'main' },
    { kind: 'released', at: T0 + 41_500, ...api, kept: false },
    { kind: 'failed', at: T0 + 50_000, ...db, error: 'lint-staged failed\nmore', stage: 'commit' },
    { kind: 'released', at: T0 + 50_100, ...db, kept: true },
    { kind: 'allocated', at: T0 + 2000, ...other, ownerLabel: 'UI phase', baseBranch: 'main' },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  useWorktreeStore.setState({
    timelineEvents: [],
    worktrees: [],
    baseBranch: 'main',
    diffByDir: {},
  });
});
afterEach(cleanup);

describe('WorktreeTimelineView', () => {
  it('draws one lane per worktree with phase segments, outcomes and the base commit', () => {
    handleWorktreeTimeline({
      type: 'worktree.timeline',
      payload: { events: lifecycle() },
    } as never);
    render(<WorktreeTimelineView sessionId="s1" />);

    const lanes = screen.getAllByTestId('worktree-lane');
    expect(lanes.map((l) => l.getAttribute('data-outcome'))).toEqual(['merged', 'failed']);
    const phases = [...lanes[0]!.querySelectorAll('[data-phase]')].map((s) =>
      s.getAttribute('data-phase'),
    );
    expect(phases).toEqual(['working', 'queued', 'merging']);
    expect(screen.getAllByTestId('worktree-base-commit')).toHaveLength(1);
    // Nothing live → no now-cursor, no repaint tick.
    expect(screen.queryByTestId('worktree-now-cursor')).toBeNull();
    expect(screen.getByText('avg merge wait 10s')).toBeTruthy();
  });

  it('opens a failed lane with its stage, error, lifecycle and working actions', async () => {
    useWorktreeStore.getState().setTimeline(lifecycle());
    render(<WorktreeTimelineView sessionId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: 'db-2 — failed' }));
    const detail = screen.getByTestId('worktree-lane-detail');
    expect(
      within(detail).getByText('Commit refused (pre-commit hook or locked index)'),
    ).toBeTruthy();
    // Full error in the error block; first line again on the lifecycle row.
    expect(within(detail).getAllByText(/lint-staged failed/)).toHaveLength(2);
    expect(within(detail).getByText('worktree created')).toBeTruthy();
    expect(within(detail).getByText('kept on disk')).toBeTruthy();
    expect(within(detail).getByText('checkout still on disk')).toBeTruthy();

    fireEvent.click(within(detail).getByRole('button', { name: 'Merge into base' }));
    await vi.waitFor(() =>
      expect(sendMock).toHaveBeenCalledWith({
        type: 'worktree.merge',
        payload: { branch: 'wstack/ap/db-2' },
      }),
    );
    fireEvent.click(within(detail).getByRole('button', { name: 'Open in terminal' }));
    expect(sendMock).toHaveBeenCalledWith({
      type: 'shell.open',
      payload: { path: `${DIR}/db-2`, target: 'terminal' },
    });
  });

  it('offers no actions on a merged, removed worktree', () => {
    useWorktreeStore.getState().setTimeline(lifecycle());
    render(<WorktreeTimelineView sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'api-1 — merged' }));
    const detail = screen.getByTestId('worktree-lane-detail');
    expect(within(detail).getByText('checkout removed')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('switches between this session and all sessions', () => {
    useWorktreeStore.getState().setTimeline(lifecycle());
    render(<WorktreeTimelineView sessionId="s1" />);
    expect(screen.getAllByTestId('worktree-lane')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'All sessions' }));
    expect(screen.getAllByTestId('worktree-lane')).toHaveLength(3);
    // The other session's worktree is still running → live cursor appears.
    expect(screen.getByTestId('worktree-now-cursor')).toBeTruthy();
  });

  it('streams new events into the store and shows an empty state before any', () => {
    render(<WorktreeTimelineView sessionId="s1" />);
    expect(screen.getByText('No worktree activity yet')).toBeTruthy();
    act(() => {
      handleWorktreeTimelineEvent({
        type: 'worktree.timeline_event',
        payload: { event: lifecycle()[0] },
      } as never);
    });
    expect(screen.getAllByTestId('worktree-lane')).toHaveLength(1);
  });

  it('compact mode renders bars only, and nothing when empty', () => {
    const { container, rerender } = render(<WorktreeTimelineView compact />);
    expect(container.firstChild).toBeNull();
    useWorktreeStore.getState().setTimeline(lifecycle());
    rerender(<WorktreeTimelineView compact />);
    const compact = screen.getByTestId('worktree-timeline-compact');
    expect(compact.querySelectorAll('[data-phase]').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('worktree-lane')).toBeNull();
  });

  it('bounds the client-side log', () => {
    const many = Array.from({ length: 1100 }, (_, i) => ({
      kind: 'released' as const,
      at: i,
      handleId: `h${i}`,
    }));
    useWorktreeStore.getState().setTimeline(many);
    useWorktreeStore.getState().pushTimelineEvent({ kind: 'released', at: 2000, handleId: 'last' });
    const events = useWorktreeStore.getState().timelineEvents;
    expect(events).toHaveLength(1000);
    expect(events.at(-1)?.handleId).toBe('last');
  });
});
