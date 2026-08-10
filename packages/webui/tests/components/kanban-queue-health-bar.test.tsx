import { render, screen } from '@testing-library/react';
import type { KanbanQueueHealth } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { KanbanQueueHealthBar } from '../../src/components/KanbanQueueHealthBar.js';

/**
 * This bar had no render coverage at all: both `KanbanView` tests set
 * `queueHealth: null`, which short-circuits the `queueHealth &&` guard that
 * mounts it. Two of the bugs it carried — rendering the always-zero
 * `counts.ready`, and calling a board with failed cards "healthy" — were the
 * kind a single render assertion would have caught.
 */

function health(overrides: Partial<KanbanQueueHealth> = {}): KanbanQueueHealth {
  return {
    generatedAt: '2026-08-10T00:00:00.000Z',
    boardIds: ['board-1'],
    counts: {
      ready: 0,
      startable: 0,
      queued: 0,
      running: 0,
      review: 0,
      failed: 0,
      completed: 0,
      pending: 0,
      archived: 0,
      blocked: 0,
    },
    dependencyBlocked: { count: 0, tasks: [] },
    staleAssignments: { count: 0, tasks: [] },
    failedRetryable: { count: 0, tasks: [] },
    heartbeatDue: { count: 0, tasks: [] },
    ...overrides,
  };
}

function counts(overrides: Partial<KanbanQueueHealth['counts']>): KanbanQueueHealth['counts'] {
  return { ...health().counts, ...overrides };
}

describe('KanbanQueueHealthBar', () => {
  it('reports startable work, never the raw ready tally', () => {
    const { container } = render(
      <KanbanQueueHealthBar
        queueHealth={health({ counts: counts({ ready: 0, startable: 3, pending: 3 }) })}
        runningCostTotal={0}
      />,
    );

    expect(container.textContent).toMatch(/3\s*ready/i);
  });

  it('shows nothing claimable when the stored status tally is the only non-zero', () => {
    // `counts.ready` is a diagnostic field; no dispatcher writes `status: 'ready'`,
    // so a bar keyed on it showed a permanent 0 while the board had work.
    // Reading it here must not resurrect a pill.
    const { container } = render(
      <KanbanQueueHealthBar
        queueHealth={health({ counts: counts({ ready: 7, startable: 0 }) })}
        runningCostTotal={0}
      />,
    );

    expect(container.textContent).not.toContain('7');
  });

  it('does not call a board with retryable failures healthy', () => {
    render(
      <KanbanQueueHealthBar
        queueHealth={health({
          counts: counts({ failed: 2 }),
          failedRetryable: { count: 2, tasks: [] },
        })}
        runningCostTotal={0}
      />,
    );

    expect(screen.queryByText(/healthy/i)).toBeNull();
  });

  it('calls a board with no live signal healthy', () => {
    render(<KanbanQueueHealthBar queueHealth={health()} runningCostTotal={0} />);

    expect(screen.getByText(/healthy/i)).toBeTruthy();
  });

  it('surfaces expired leases and dependency blocks', () => {
    const { container } = render(
      <KanbanQueueHealthBar
        queueHealth={health({
          staleAssignments: { count: 1, tasks: [] },
          dependencyBlocked: { count: 4, tasks: [] },
        })}
        runningCostTotal={0}
      />,
    );

    expect(screen.queryByText(/healthy/i)).toBeNull();
    expect(container.textContent).toMatch(/1\s*stale/i);
    expect(container.textContent).toMatch(/4\s*blocked by deps/i);
  });

  it('renders the running cost only when there is one', () => {
    const { rerender, container } = render(
      <KanbanQueueHealthBar queueHealth={health()} runningCostTotal={0} />,
    );
    expect(container.textContent).not.toContain('12.50');

    rerender(<KanbanQueueHealthBar queueHealth={health()} runningCostTotal={12.5} />);
    expect(container.textContent).toContain('12.50');
  });
});
