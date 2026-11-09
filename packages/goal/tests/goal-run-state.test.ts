import { describe, expect, it, vi } from 'vitest';
import { canTransitionGoalRun, transitionGoalRun } from '../src/goal-run-state.js';

describe('goal run lifecycle table', () => {
  it.each([
    [undefined, 'planning'],
    [undefined, 'running'],
    ['planning', 'stopped'],
    ['planning', 'failed'],
    ['running', 'paused'],
    ['running', 'completed'],
    ['paused', 'running'],
    ['paused', 'completed'],
    ['stopped', 'running'],
    ['failed', 'running'],
    ['failed', undefined],
    ['completed', undefined],
  ] as const)('allows %s -> %s', (from, to) => {
    expect(canTransitionGoalRun(from, to)).toBe(true);
  });

  it.each([
    ['completed', 'paused'],
    ['completed', 'running'],
    ['completed', 'stopped'],
    ['completed', 'failed'],
    ['planning', 'paused'],
    ['stopped', 'completed'],
  ] as const)('refuses %s -> %s', (from, to) => {
    expect(canTransitionGoalRun(from, to)).toBe(false);
  });

  it('applies an allowed move and leaves the graph untouched on a refused one', () => {
    const graph: { id: string; runState?: 'running' | 'paused' | 'completed' } = {
      id: 'g1',
      runState: 'running',
    };
    expect(transitionGoalRun(graph, 'completed')).toBe(true);
    expect(graph.runState).toBe('completed');

    const refused = vi.fn();
    expect(transitionGoalRun(graph, 'paused', refused)).toBe(false);
    expect(graph.runState).toBe('completed');
    expect(refused).toHaveBeenCalledWith('Goal g1 refused run state completed -> paused');
  });
});
