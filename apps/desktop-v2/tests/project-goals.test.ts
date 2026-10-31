import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { matchingGoalAssessment } from '../src/goal-assessment';
import { ProjectGoals } from '../src/ProjectGoals';
import { ProjectMission } from '../src/ProjectMission';

describe('project goals', () => {
  it('renders the persistent mission, progress, deliverables and activity without treating it as an execution graph', () => {
    const state = reduceEngine(emptyEngineState, {
      type: 'goal-state.updated',
      payload: {
        goal: 'Keep the project maintainable',
        goalState: 'paused',
        progress: 35,
        iterations: 4,
        refinedGoal: 'Keep boundaries explicit',
        deliverables: ['[x] Document ownership', 'Add checks'],
        journal: [{ iteration: 3, task: 'Review boundaries' }],
      },
    });
    const html = renderToStaticMarkup(
      createElement(ProjectMission, { state, send: async () => {} }),
    );
    for (const expected of [
      'Keep the project maintainable',
      'Keep boundaries explicit',
      '35%',
      'Document ownership',
      'Add checks',
      'Review boundaries',
      'Resume',
    ])
      expect(html).toContain(expected);
    expect(html).not.toContain('Execution goals');
  });
  it('ignores assessment replies for an older or cleared draft', () => {
    const current = { reqSeq: 42, realistic: false, concerns: ['Scope is too broad'] };
    expect(matchingGoalAssessment(current, 42)).toEqual(current);
    expect(matchingGoalAssessment(current, 43)).toBeNull();
    expect(matchingGoalAssessment(current, 0)).toBeNull();
    expect(matchingGoalAssessment({ realistic: true }, 42)).toBeNull();
  });
  it('retains separate goal snapshots and errors across session owners', () => {
    let state = reduceEngine(emptyEngineState, {
      type: 'session.start',
      payload: { sessionId: 'desktop-session' },
    });
    state = reduceEngine(state, {
      type: 'goal.state',
      payload: { sessionId: 'worker-a', goalId: 'a', title: 'First' },
    });
    state = reduceEngine(state, {
      type: 'goal.state',
      payload: { sessionId: 'worker-b', goalId: 'b', title: 'Second' },
    });
    state = reduceEngine(state, {
      type: 'goal.error',
      payload: { goalId: 'a', message: 'First refused' },
    });
    state = reduceEngine(state, {
      type: 'goal.error',
      payload: { goalId: 'b', message: 'Second refused' },
    });
    state = reduceEngine(state, { type: 'goal.state', payload: { title: 'Unscoped' } });
    expect(state.goalStates['a']?.['title']).toBe('First');
    expect(state.goalStates['b']?.['title']).toBe('Second');
    expect(state.goalErrors['a']?.['message']).toBe('First refused');
    expect(state.goalErrors['b']?.['message']).toBe('Second refused');
    expect(Object.keys(state.goalStates)).toEqual(['a', 'b']);
    expect(state.messages).toEqual([]);
  });

  it('renders reported catalog data without inventing missing counts or verification', () => {
    const state = reduceEngine(emptyEngineState, {
      type: 'goal.list',
      payload: {
        goals: [
          {
            id: 'a',
            title: 'Ship desktop',
            status: 'running',
            completedTasks: 2,
            totalTasks: 5,
            completedPhases: 1,
            totalPhases: 3,
            percentComplete: 40,
            verification: 'passed',
          },
          { id: 'b', title: 'Legacy goal' },
          { title: 'Invalid goal' },
        ],
      },
    });
    const html = renderToStaticMarkup(
      createElement(ProjectGoals, {
        state,
        send: async () => {},
        onKanban: () => {},
      }),
    );
    expect(html).toContain('Ship desktop');
    expect(html).toContain('2 / 5 tasks');
    expect(html).toContain('40%');
    expect(html).toContain('Verification: passed');
    expect(html).toContain('Legacy goal');
    expect(html).toContain('— / — tasks');
    expect(html).toContain('Verification: —');
    expect(html).not.toContain('Invalid goal');
  });
});
