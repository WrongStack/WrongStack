import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoalStore } from '../../src/stores/goal-store';
import { parseGoalState } from '../../src/lib/goal';

// ── ws-client stub ───────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send: mockSend }) }));

// ── helpers ────────────────────────────────────────────────────────

function makeGoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    goal: 'Test goal',
    refinedGoal: 'Refined test goal',
    goalState: 'active',
    iterations: 5,
    progress: 0.6,
    progressNote: 'Working on it',
    progressTrend: 'accelerating',
    deliverables: [
      { id: 'd1', text: 'Deliverable 1', status: 'pending' },
      { id: 'd2', text: '✅ Done deliverable', status: 'done' },
    ],
    journal: [
      {
        iteration: 1,
        task: 'First task',
        status: 'completed',
        progress: 0.5,
        timestamp: '2024-01-01T00:00:00Z',
      },
    ],
    lastTask: 'Current task',
    lastStatus: 'running',
    ...overrides,
  };
}

function resetStore() {
  useGoalStore.setState({ goal: null });
  mockSend.mockReset();
}

// ── parseGoalState (unit tests) ──────────────────────────────────

describe('parseGoalState', () => {
  it('returns null for null input', () => {
    expect(parseGoalState(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(parseGoalState(undefined as never as null)).toBeNull();
  });

  it('returns null when goal is missing', () => {
    expect(parseGoalState({ goalState: 'active' })).toBeNull();
  });

  it('returns null when goal is empty string', () => {
    expect(parseGoalState({ goal: '' })).toBeNull();
  });

  it('returns null when goal is whitespace-only', () => {
    expect(parseGoalState({ goal: '   ' })).toBeNull();
  });

  it('returns null when goal is not a string', () => {
    expect(parseGoalState({ goal: null as never as string })).toBeNull();
    expect(parseGoalState({ goal: null as string })).toBeNull();
  });

  it('parses a full goal object', () => {
    const raw = makeGoal();
    const result = parseGoalState(raw);
    expect(result?.goal).toBe('Test goal');
    expect(result?.refinedGoal).toBe('Refined test goal');
    expect(result?.goalState).toBe('active');
    expect(result?.iterations).toBe(5);
    expect(result?.progress).toBe(0.6);
    expect(result?.progressNote).toBe('Working on it');
  });

  it('maps progressTrend accelerating → up', () => {
    const result = parseGoalState(makeGoal({ progressTrend: 'accelerating' }));
    expect(result?.progressTrend).toBe('up');
  });

  it('maps progressTrend stalling → down', () => {
    const result = parseGoalState(makeGoal({ progressTrend: 'stalling' }));
    expect(result?.progressTrend).toBe('down');
  });

  it('maps progressTrend steady → stable', () => {
    const result = parseGoalState(makeGoal({ progressTrend: 'steady' }));
    expect(result?.progressTrend).toBe('stable');
  });

  it('defaults progressTrend to undefined for unknown values', () => {
    const result = parseGoalState(makeGoal({ progressTrend: 'unknown' }));
    expect(result?.progressTrend).toBeUndefined();
  });

  it('defaults goalState to active for invalid values', () => {
    for (const invalid of ['invalid', 'running', '', 'ACTIVE']) {
      const result = parseGoalState(makeGoal({ goalState: invalid }));
      expect(result?.goalState).toBe('active');
    }
  });

  it('normalizes valid goalState values', () => {
    for (const state of ['active', 'paused', 'completed', 'failed', 'abandoned']) {
      const result = parseGoalState(makeGoal({ goalState: state }));
      expect(result?.goalState).toBe(state);
    }
  });

  it('defaults iterations to 0 when missing', () => {
    const result = parseGoalState(makeGoal({ iterations: undefined }));
    expect(result?.iterations).toBe(0);
  });

  it('defaults iterations to 0 when non-number', () => {
    const result = parseGoalState(makeGoal({ iterations: 'five' as never as number }));
    expect(result?.iterations).toBe(0);
  });

  it('defaults progress to 0 when missing', () => {
    const result = parseGoalState(makeGoal({ progress: undefined }));
    expect(result?.progress).toBe(0);
  });

  it('parses string deliverables', () => {
    const result = parseGoalState(
      makeGoal({
        deliverables: ['Task 1', '✅ Done task', '  [x] partial  '] as unknown[],
      }),
    );
    expect(result?.deliverables).toHaveLength(3);
    expect(result?.deliverables?.[0]).toEqual({ id: 'd0', text: 'Task 1', status: 'pending' });
    expect(result?.deliverables?.[1]).toEqual({ id: 'd1', text: '✅ Done task', status: 'done' });
    expect(result?.deliverables?.[2]).toEqual({
      id: 'd2',
      text: '  [x] partial  ',
      status: 'pending',
    });
  });

  it('preserves object deliverables', () => {
    const result = parseGoalState(
      makeGoal({
        deliverables: [{ id: 'custom', text: 'Custom', status: 'done' }],
      }),
    );
    expect(result?.deliverables?.[0]).toEqual({ id: 'custom', text: 'Custom', status: 'done' });
  });

  it('defaults progressNote to undefined when missing', () => {
    const result = parseGoalState(makeGoal({ progressNote: undefined }));
    expect(result?.progressNote).toBeUndefined();
  });

  it('defaults lastTask to undefined when missing', () => {
    const result = parseGoalState(makeGoal({ lastTask: undefined }));
    expect(result?.lastTask).toBeUndefined();
  });

  it('defaults lastStatus to undefined when missing', () => {
    const result = parseGoalState(makeGoal({ lastStatus: undefined }));
    expect(result?.lastStatus).toBeUndefined();
  });
});

// ── useGoalStore (integration tests) ───────────────────────────────

describe('useGoalStore', () => {
  beforeEach(() => resetStore());

  describe('setGoal', () => {
    it('parses and stores a goal', () => {
      useGoalStore.getState().setGoal(makeGoal());
      const goal = useGoalStore.getState().goal!;
      expect(goal.goal).toBe('Test goal');
      expect(goal.refinedGoal).toBe('Refined test goal');
      expect(goal.goalState).toBe('active');
      expect(goal.iterations).toBe(5);
      expect(goal.progress).toBe(0.6);
    });

    it('handles null input', () => {
      useGoalStore.getState().setGoal(null);
      expect(useGoalStore.getState().goal).toBeNull();
    });

    it('handles empty object', () => {
      useGoalStore.getState().setGoal({});
      expect(useGoalStore.getState().goal).toBeNull();
    });

    it('overwrites previous goal', () => {
      useGoalStore.getState().setGoal(makeGoal({ goal: 'First' }));
      useGoalStore.getState().setGoal(makeGoal({ goal: 'Second' }));
      expect(useGoalStore.getState().goal?.goal).toBe('Second');
    });
  });

  describe('clear', () => {
    it('sets goal to null', () => {
      useGoalStore.getState().setGoal(makeGoal());
      useGoalStore.getState().clear();
      expect(useGoalStore.getState().goal).toBeNull();
    });

    it('is idempotent', () => {
      useGoalStore.getState().clear();
      useGoalStore.getState().clear();
      expect(useGoalStore.getState().goal).toBeNull();
    });
  });

  describe('appendJournalEntry', () => {
    it('adds live eternal iteration entries to the current goal', () => {
      useGoalStore.getState().setGoal(makeGoal({ iterations: 5, journal: [] }));
      useGoalStore.getState().appendJournalEntry({
        iteration: 6,
        task: 'Run verification',
        status: 'success',
        timestamp: '2026-06-23T00:00:00Z',
      });
      const goal = useGoalStore.getState().goal!;
      expect(goal.iterations).toBe(6);
      expect(goal.lastTask).toBe('Run verification');
      expect(goal.lastStatus).toBe('success');
      expect(goal.journal?.[0]).toMatchObject({ iteration: 6, task: 'Run verification' });
    });

    it('is a no-op when no goal is loaded', () => {
      useGoalStore.getState().appendJournalEntry({ iteration: 1, task: 'noop' });
      expect(useGoalStore.getState().goal).toBeNull();
    });
  });

  describe('refresh', () => {
    beforeEach(() => resetStore());

    it('sends goal.get via WS', () => {
      useGoalStore.getState().refresh();
      expect(mockSend).toHaveBeenCalledOnce();
      expect(mockSend).toHaveBeenCalledWith({ type: 'goal.get' });
    });

    it('throws nothing when WS is disconnected', () => {
      vi.doMock('@/lib/ws-client', () => ({ getWSClient: () => null }));
      expect(() => useGoalStore.getState().refresh()).not.toThrow();
      vi.doMock('@/lib/ws-client', () => ({ getWSClient: () => ({ send: mockSend }) }));
    });

    it('throws nothing when send is missing', () => {
      vi.doMock('@/lib/ws-client', () => ({ getWSClient: () => ({ send: undefined }) }));
      expect(() => useGoalStore.getState().refresh()).not.toThrow();
      vi.doMock('@/lib/ws-client', () => ({ getWSClient: () => ({ send: mockSend }) }));
    });
  });
});
