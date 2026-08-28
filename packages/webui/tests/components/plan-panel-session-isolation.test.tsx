import { fireEvent, render, screen, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanPanel } from '../../src/components/PlanPanel';
import { DEFAULT_LANE_ID, disposeLane, useChatLanes } from '../../src/stores/chat-lanes';
import {
  SESSION_DEFAULT_LANE_ID,
  setActiveSessionLane,
  useSessionLanes,
} from '../../src/stores/session-lanes';

const mockListeners: Record<string, ((msg: unknown) => void)[]> = {};
const mockWs = {
  getPlan: vi.fn(),
  updatePlanItem: vi.fn(),
  on: vi.fn((event: string, cb: (msg: unknown) => void) => {
    if (!mockListeners[event]) mockListeners[event] = [];
    mockListeners[event].push(cb);
    return () => {
      mockListeners[event] = (mockListeners[event] || []).filter((fn) => fn !== cb);
    };
  }),
};

vi.mock('../../src/lib/ws-client', () => ({
  getWSClient: () => mockWs,
}));

vi.mock('../../src/i18n', () => ({
  useAppTranslation: () => ({
    t: (k: string, opts?: any) => {
      if (typeof opts === 'string') return opts;
      if (opts && typeof opts === 'object' && 'defaultValue' in opts) return opts.defaultValue;
      return k;
    },
  }),
}));

describe('PlanPanel session isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockListeners)) delete mockListeners[key];
    useChatLanes.setState({ lanes: {}, activeSessionId: DEFAULT_LANE_ID });
    useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
  });

  it('preserves collapsed section state across session switches and prunes on disposeLane', () => {
    setActiveSessionLane('s1');
    const { rerender } = render(<PlanPanel />);

    // Simulate receiving plan for s1
    act(() => {
      mockListeners['plan.updated']?.forEach((cb) => {
        cb({
          payload: {
            sessionId: 's1',
            plan: {
              items: [
                { id: 'p1', title: 'Task 1 in progress', status: 'in_progress' },
                { id: 'p2', title: 'Task 2 open', status: 'open' },
              ],
            },
          },
        });
      });
    });

    expect(screen.getByText('Task 1 in progress')).toBeTruthy();
    expect(screen.getByText('Task 2 open')).toBeTruthy();

    // Toggle collapse for in_progress
    const inProgressBtn = screen.getByText(/statusInProgress/i);
    fireEvent.click(inProgressBtn);

    // Item should be collapsed (not in document)
    expect(screen.queryByText('Task 1 in progress')).toBeNull();

    // Switch to session s2
    act(() => {
      setActiveSessionLane('s2');
    });
    rerender(<PlanPanel />);

    // Simulate receiving plan for s2
    act(() => {
      mockListeners['plan.updated']?.forEach((cb) => {
        cb({
          payload: {
            sessionId: 's2',
            plan: {
              items: [
                { id: 'p3', title: 'S2 Task in progress', status: 'in_progress' },
              ],
            },
          },
        });
      });
    });

    // In s2, in_progress should NOT be collapsed
    expect(screen.getByText('S2 Task in progress')).toBeTruthy();

    // Switch back to s1
    act(() => {
      setActiveSessionLane('s1');
    });
    rerender(<PlanPanel />);

    act(() => {
      mockListeners['plan.updated']?.forEach((cb) => {
        cb({
          payload: {
            sessionId: 's1',
            plan: {
              items: [
                { id: 'p1', title: 'Task 1 in progress', status: 'in_progress' },
              ],
            },
          },
        });
      });
    });

    // S1 in_progress should still be collapsed!
    expect(screen.queryByText('Task 1 in progress')).toBeNull();

    // Dispose s1 lane and switch to s2 (as happens when closing s1 tab)
    act(() => {
      disposeLane('s1');
      setActiveSessionLane('s2');
    });
    rerender(<PlanPanel />);

    // Switch to s1 fresh again
    act(() => {
      setActiveSessionLane('s1');
    });
    rerender(<PlanPanel />);

    act(() => {
      mockListeners['plan.updated']?.forEach((cb) => {
        cb({
          payload: {
            sessionId: 's1',
            plan: {
              items: [
                { id: 'p1', title: 'Task 1 in progress', status: 'in_progress' },
              ],
            },
          },
        });
      });
    });

    // After disposal and returning, s1 state is fresh (not collapsed)
    expect(screen.getByText('Task 1 in progress')).toBeTruthy();
  });
});
