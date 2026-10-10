import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { GoalSummary } from '@wrongstack/core/goal';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MyGoals } from '../../src/components/MyGoals';
import {
  handleGoalLifecycle,
  handleGoalProgress,
  handleGoalState,
} from '../../src/hooks/ws-handlers/goal-handlers';
import { useGoalCatalogStore } from '../../src/stores/goal-catalog-store';
import { useGoalRunStore } from '../../src/stores/goal-run-store';

function goal(id: string, sessionId: string): GoalSummary {
  return {
    id,
    title: `Goal ${id}`,
    sessionId,
    status: 'running',
    updatedAt: 1,
    percentComplete: 25,
    completedTasks: 1,
    totalTasks: 4,
    completedPhases: 0,
    totalPhases: 1,
    phases: [
      { id: `phase-${id}`, name: 'Build', status: 'running', completedTasks: 1, totalTasks: 4 },
    ],
    blockers: [],
    reachability: 'unknown',
    verification: 'not_run',
    branch: `wstack/ap/${id}`,
    ownerId: id,
  };
}
beforeEach(() => {
  useGoalCatalogStore.setState({ goals: [], selectedGoalId: null });
  useGoalRunStore.getState().clear();
});
afterEach(cleanup);

it('lists project goals, filters by session/id and selects without stopping another goal', () => {
  useGoalCatalogStore
    .getState()
    .setGoals([goal('alpha', 'session-one'), goal('beta', 'session-two')]);
  const onSelect = vi.fn();
  const onNew = vi.fn();
  render(<MyGoals sessionId="session-one" onSelect={onSelect} onNew={onNew} />);
  expect(screen.getByRole('heading', { name: 'My Goals' })).toBeTruthy();
  expect(screen.getByText('Goal beta')).toBeTruthy();
  fireEvent.click(screen.getByRole('checkbox', { name: 'This session' }));
  expect(screen.queryByText('Goal beta')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: 'This session' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Search goals or id' }), {
    target: { value: 'beta' },
  });
  expect(screen.queryByText('Goal alpha')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Goal beta/ }));
  expect(onSelect).toHaveBeenCalledWith('beta');
  fireEvent.click(screen.getByRole('button', { name: 'New goal' }));
  expect(onNew).toHaveBeenCalledOnce();
});

it('does not invent progress or reachability for an unplanned goal', () => {
  useGoalCatalogStore.getState().setGoals([
    {
      ...goal('unplanned', 'session'),
      percentComplete: null,
      totalTasks: 0,
      completedTasks: 0,
      phases: [],
    },
  ]);
  render(<MyGoals onSelect={() => {}} onNew={() => {}} />);
  expect(screen.getByRole('button', { name: /Goal unplanned.*—/ })).toBeTruthy();
  expect(screen.getByText(/Reachability: Unknown/)).toBeTruthy();
});

it('rejects events from another goal and preserves pause/terminal state during progress', () => {
  useGoalCatalogStore.getState().selectGoal('alpha');
  useGoalRunStore.getState().setState({ graphId: 'alpha', title: 'Alpha', status: 'paused' });
  handleGoalState({
    type: 'goal.state',
    payload: { goalId: 'beta', graphId: 'beta', title: 'Beta', status: 'running' },
  } as never);
  handleGoalLifecycle({ type: 'goal.completed', payload: { goalId: 'beta' } } as never);
  expect(useGoalRunStore.getState()).toMatchObject({
    graphId: 'alpha',
    title: 'Alpha',
    status: 'paused',
  });
  for (const status of ['paused', 'stopped', 'completed', 'failed'] as const) {
    useGoalRunStore.getState().setState({ status });
    handleGoalProgress({
      type: 'goal.progress',
      payload: { goalId: 'alpha', completedTasks: 2, failedTasks: 1, percentComplete: 50 },
    } as never);
    expect(useGoalRunStore.getState().status).toBe(status);
  }
});
