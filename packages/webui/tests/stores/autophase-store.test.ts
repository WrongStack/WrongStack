import { afterEach, describe, expect, it } from 'vitest';
import { useGoalRunStore } from '../../src/stores/goal-run-store';

describe('goal run store', () => {
  afterEach(() => {
    useGoalRunStore.setState({
      phases: [],
      activePhaseId: null,
      overallPercent: 0,
      autonomous: false,
      title: null,
      status: 'idle',
      lastEvent: null,
      lastError: null,
      progress: null,
    });
  });

  it('setState patches each field individually', () => {
    useGoalRunStore
      .getState()
      .setState({ phases: [{ id: 'p1', label: 'Thinking', status: 'active' }] });
    expect(useGoalRunStore.getState().phases).toHaveLength(1);
  });

  it('setState preserves unspecified fields', () => {
    useGoalRunStore.setState({
      phases: [{ id: 'p1', label: 'Thinking', status: 'active' }],
      autonomous: true,
    });
    useGoalRunStore.getState().setState({ title: 'My Title', status: 'running' });
    // autonomous should still be true (not reset)
    expect(useGoalRunStore.getState().title).toBe('My Title');
    expect(useGoalRunStore.getState().autonomous).toBe(true);
    expect(useGoalRunStore.getState().status).toBe('running');
  });

  it('stores lifecycle and progress metadata', () => {
    useGoalRunStore.getState().setState({
      status: 'running',
      lastEvent: 'progress',
      progress: {
        totalPhases: 4,
        completed: 2,
        failed: 0,
        totalTasks: 8,
        completedTasks: 3,
        failedTasks: 0,
      },
    });
    const s = useGoalRunStore.getState();
    expect(s.status).toBe('running');
    expect(s.lastEvent).toBe('progress');
    expect(s.progress?.completedTasks).toBe(3);
  });

  it('clear resets all fields', () => {
    useGoalRunStore.setState({
      phases: [{ id: 'p1', label: 'Thinking', status: 'active' }],
      activePhaseId: 'p1',
      overallPercent: 50,
      autonomous: true,
      title: 'Test',
      status: 'failed',
      lastEvent: 'failed',
      lastError: 'boom',
      progress: {
        totalPhases: 1,
        completed: 0,
        failed: 1,
        totalTasks: 2,
        completedTasks: 1,
        failedTasks: 1,
      },
    });
    useGoalRunStore.getState().clear();
    const s = useGoalRunStore.getState();
    expect(s.phases).toEqual([]);
    expect(s.activePhaseId).toBeNull();
    expect(s.overallPercent).toBe(0);
    expect(s.autonomous).toBe(false);
    expect(s.title).toBeNull();
    expect(s.status).toBe('idle');
    expect(s.lastEvent).toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.progress).toBeNull();
  });
});
