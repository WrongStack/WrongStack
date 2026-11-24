import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app-reducer.js';
import type { State } from '../src/app-state.js';
import { useTuiEventBridge } from '../src/hooks/use-tui-event-bridge.js';

/**
 * PhaseOrchestrator.executePhaseTasks settles each concurrency batch in a
 * synchronous for-loop (markTaskCompleted per fulfilled task), so several
 * `phase.taskCompleted` events reach the TUI goal handler in one tick with no
 * render between them. The completed-tasks arithmetic must therefore live in
 * the reducer (which applies every action against its own latest state), not
 * in the handler reading the render-synced stateRef.
 */
type GoalHandler = (event: string, payload: unknown) => void;

interface Captured {
  handler?: GoalHandler | undefined;
  stateRef?: { current: State } | undefined;
}

function stubEventBus(): unknown {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  return {
    on(event: string, cb: (p: unknown) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
      return () => {
        set?.delete(cb);
      };
    },
    onPattern(_pattern: unknown, _cb: unknown) {
      return () => {};
    },
  };
}

const baseState = { fleetChat: 'full' } as unknown as State;

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mountBridge(captured: Captured) {
  function Harness() {
    const [state, dispatch] = React.useReducer(reducer, baseState);
    const stateRef = React.useRef(state);
    stateRef.current = state;
    useTuiEventBridge({
      events: stubEventBus() as never,
      dispatch,
      stateRef,
      setActiveMaxContext: () => {},
      getSessionId: () => 'sess-goalrun-count',
      subscribeGoal: (h) => {
        captured.handler = h;
        captured.stateRef = stateRef;
        return () => {};
      },
    });
    return null;
  }
  return render(React.createElement(Harness));
}

function phaseView(captured: Captured) {
  return captured.stateRef?.current.goalRun?.phases['p1'];
}

describe('goal run task counting', () => {
  it('counts every taskCompleted in a same-tick settlement batch', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;

      h('phase.started', { phaseId: 'p1', name: 'Alpha' });
      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');

      h('phase.taskStarted', { phaseId: 'p1', taskId: 't1', taskTitle: 'T1' });
      h('phase.taskStarted', { phaseId: 'p1', taskId: 't2', taskTitle: 'T2' });
      await until(() => (phaseView(captured)?.activeTasks ?? []).length === 2, 'both tasks active');

      // Same-tick pair, exactly as the orchestrator's allSettled loop emits
      // them when task concurrency is explicitly raised above the safe default.
      h('phase.taskCompleted', { phaseId: 'p1', taskId: 't1', taskTitle: 'T1' });
      h('phase.taskCompleted', { phaseId: 'p1', taskId: 't2', taskTitle: 'T2' });

      // Witness that BOTH events were fully processed (both tasks left the
      // active list) before asserting the counter.
      await until(
        () => (phaseView(captured)?.activeTasks ?? []).length === 0,
        'both completions processed',
      );

      expect(phaseView(captured)?.completedTasks).toBe(2);
    } finally {
      view.unmount();
    }
  });

  it('control: render-separated completions still count one each', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;

      h('phase.started', { phaseId: 'p1', name: 'Alpha' });
      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');

      h('phase.taskStarted', { phaseId: 'p1', taskId: 't1', taskTitle: 'T1' });
      h('phase.taskStarted', { phaseId: 'p1', taskId: 't2', taskTitle: 'T2' });
      await until(() => (phaseView(captured)?.activeTasks ?? []).length === 2, 'both tasks active');

      h('phase.taskCompleted', { phaseId: 'p1', taskId: 't1', taskTitle: 'T1' });
      await until(
        () => phaseView(captured)?.completedTasks === 1,
        'first render-separated completion counted',
      );

      h('phase.taskCompleted', { phaseId: 'p1', taskId: 't2', taskTitle: 'T2' });
      await until(
        () => (phaseView(captured)?.activeTasks ?? []).length === 0,
        'second completion processed',
      );

      expect(phaseView(captured)?.completedTasks).toBe(2);
    } finally {
      view.unmount();
    }
  });

  it('accepts the Core autonomous.tick string-id payload without losing running phases', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;
      h('phase.started', {
        phaseId: 'p1',
        name: 'Alpha',
        completedTasks: 0,
        totalTasks: 2,
      });
      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');
      h('autonomous.tick', { activePhases: ['p1'], queuedPhases: [] });
      await until(
        () => captured.stateRef?.current.goalRun?.runningPhaseIds[0] === 'p1',
        'running phase id applied',
      );
      expect(captured.stateRef?.current.goalRun?.runningPhaseIds).toEqual(['p1']);
      expect(phaseView(captured)?.totalTasks).toBe(2);
    } finally {
      view.unmount();
    }
  });

  it('preserves phase identity and counters across statusChange and completion', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;
      h('phase.started', {
        phaseId: 'p1',
        name: 'Alpha',
        completedTasks: 1,
        totalTasks: 3,
      });
      await until(() => phaseView(captured)?.totalTasks === 3, 'phase counts registered');
      h('phase.statusChange', { phaseId: 'p1', from: 'running', to: 'paused' });
      await until(() => phaseView(captured)?.status === 'paused', 'phase paused');
      h('phase.completed', { phaseId: 'p1', name: 'Alpha', durationMs: 10 });
      await until(() => phaseView(captured)?.status === 'completed', 'phase completed');
      expect(phaseView(captured)).toMatchObject({
        name: 'Alpha',
        completedTasks: 1,
        totalTasks: 3,
      });
    } finally {
      view.unmount();
    }
  });

  it('keeps terminal goal details visible after graph completion', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;
      h('phase.started', {
        phaseId: 'p1',
        name: 'Alpha',
        completedTasks: 0,
        totalTasks: 1,
      });
      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');
      h('phase.completed', { phaseId: 'p1', name: 'Alpha', durationMs: 10 });
      h('graph.completed', { graphId: 'g1', durationMs: 10 });
      await until(() => phaseView(captured)?.status === 'completed', 'terminal state retained');
      expect(captured.stateRef?.current.goalRun).not.toBeNull();
      expect(captured.stateRef?.current.goalRun?.runningPhaseIds).toEqual([]);
    } finally {
      view.unmount();
    }
  });

  it('applies phase.statusChange in the same tick as phase.started', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;

      // The orchestrator can start and immediately report a status change
      // (pause/fail) before React renders the phase into stateRef. The status
      // must still land; a stale-ref lookup here used to drop it entirely.
      h('phase.started', {
        phaseId: 'p1',
        name: 'Alpha',
        completedTasks: 1,
        totalTasks: 3,
      });
      h('phase.statusChange', { phaseId: 'p1', from: 'running', to: 'paused' });

      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');
      expect(phaseView(captured)?.status).toBe('paused');
      expect(phaseView(captured)).toMatchObject({ completedTasks: 1, totalTasks: 3 });
    } finally {
      view.unmount();
    }
  });

  it('preserves started counts when phase.completed arrives in the same tick', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;

      // Same-tick start/completion: the completion event carries no counts, so
      // reading them from the render-synced stateRef overwrote the started
      // numbers with 0/0. Completion must preserve the phase's own counts.
      h('phase.started', {
        phaseId: 'p1',
        name: 'Alpha',
        completedTasks: 1,
        totalTasks: 3,
      });
      h('phase.completed', { phaseId: 'p1', name: 'Alpha', durationMs: 10 });

      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');
      expect(phaseView(captured)?.status).toBe('completed');
      expect(phaseView(captured)).toMatchObject({ completedTasks: 1, totalTasks: 3 });
    } finally {
      view.unmount();
    }
  });

  it('reducer counts sequential goalRunTaskCompleted actions against latest state', () => {
    let s = reducer(baseState, { type: 'goalRunInit', title: 'T' });
    s = reducer(s, {
      type: 'goalRunPhaseUpdate',
      phaseId: 'p1',
      name: 'Alpha',
      status: 'running',
      completedTasks: 0,
      totalTasks: 0,
    });
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      title: 'T1',
      active: true,
    });
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't2',
      title: 'T2',
      active: true,
    });
    s = reducer(s, { type: 'goalRunTaskCompleted', phaseId: 'p1', taskId: 't1' });
    s = reducer(s, { type: 'goalRunTaskCompleted', phaseId: 'p1', taskId: 't2' });
    const phase = s.goalRun?.phases['p1'];
    expect(phase?.completedTasks).toBe(2);
    expect(phase?.activeTasks ?? []).toHaveLength(0);
  });

  it('ignores goalRunTaskCompleted for an unknown phase', () => {
    const s = reducer(baseState, { type: 'goalRunInit', title: 'T' });
    const next = reducer(s, { type: 'goalRunTaskCompleted', phaseId: 'nope', taskId: 't1' });
    expect(next).toBe(s);
  });
});

describe('goal run agent assignment', () => {
  it('attaches the agent when taskAssigned follows taskStarted in the same tick', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;

      h('phase.started', { phaseId: 'p1', name: 'Alpha' });
      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');

      // Production order, one tick: executeSingleTask emits taskStarted (no
      // assignee yet — the normal fresh-task path) and then calls
      // ctx.executeTask synchronously, whose setTaskAssignee emits
      // taskAssigned with the worker nickname before any render can happen.
      h('phase.taskStarted', { phaseId: 'p1', taskId: 't1', taskTitle: 'T1' });
      h('phase.taskAssigned', { phaseId: 'p1', taskId: 't1', agentName: 'executor-2' });

      await until(() => (phaseView(captured)?.activeTasks ?? []).length === 1, 'task t1 active');

      expect(phaseView(captured)?.activeTasks?.[0]?.agent).toBe('executor-2');
    } finally {
      view.unmount();
    }
  });

  it('control: render-separated taskAssigned still attaches the agent', async () => {
    const captured: Captured = {};
    const view = mountBridge(captured);
    try {
      await until(() => captured.handler !== undefined, 'subscribeGoal handler captured');
      const h = captured.handler as GoalHandler;

      h('phase.started', { phaseId: 'p1', name: 'Alpha' });
      await until(() => phaseView(captured) !== undefined, 'phase p1 registered');

      h('phase.taskStarted', { phaseId: 'p1', taskId: 't1', taskTitle: 'T1' });
      await until(() => (phaseView(captured)?.activeTasks ?? []).length === 1, 'task t1 active');

      h('phase.taskAssigned', { phaseId: 'p1', taskId: 't1', agentName: 'executor-9' });

      await until(
        () => phaseView(captured)?.activeTasks?.[0]?.agent === 'executor-9',
        'agent attached',
      );
      expect(phaseView(captured)?.activeTasks?.[0]?.agent).toBe('executor-9');
    } finally {
      view.unmount();
    }
  });

  it('reducer attaches goalRunTaskAgent in place and ignores non-active tasks', () => {
    let s = reducer(baseState, { type: 'goalRunInit', title: 'T' });
    s = reducer(s, {
      type: 'goalRunPhaseUpdate',
      phaseId: 'p1',
      name: 'Alpha',
      status: 'running',
      completedTasks: 0,
      totalTasks: 0,
    });
    s = reducer(s, {
      type: 'goalRunTaskActive',
      phaseId: 'p1',
      taskId: 't1',
      title: 'T1',
      active: true,
    });
    s = reducer(s, { type: 'goalRunTaskAgent', phaseId: 'p1', taskId: 't1', agent: 'w1' });
    expect(s.goalRun?.phases['p1']?.activeTasks?.[0]?.agent).toBe('w1');

    // Unknown task: no-op, same reference (assignment of a not-started task
    // must not create a bogus live-worker row).
    const next = reducer(s, { type: 'goalRunTaskAgent', phaseId: 'p1', taskId: 'zz', agent: 'w2' });
    expect(next).toBe(s);
  });
});
