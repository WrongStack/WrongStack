import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoordinatorEvent } from '@wrongstack/core/coordination';
import { useAutonomousCoordinator } from '../src/hooks/use-autonomous-coordinator.js';
import { Text } from '../src/ink.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function createHarness() {
  const dispatch = vi.fn();
  const subscribeCoordinatorEvents = vi.fn(() => () => {});

  function Harness(): React.ReactElement {
    useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);
    return React.createElement(Text, null, 'test');
  }

  const view = render(React.createElement(Harness));
  return { dispatch, subscribeCoordinatorEvents, view };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAutonomousCoordinator', () => {
  it('subscribes to coordinator events on mount', () => {
    const { subscribeCoordinatorEvents, view } = createHarness();
    expect(subscribeCoordinatorEvents).toHaveBeenCalledWith(expect.any(Function));
    view.unmount();
  });

  it('unsubscribes on unmount', () => {
    const unsubscribe = vi.fn();
    const subscribeCoordinatorEvents = vi.fn(() => unsubscribe);
    const dispatch = vi.fn();

    function Harness(): React.ReactElement {
      useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);
      return React.createElement(Text, null, 'test');
    }

    const view = render(React.createElement(Harness));
    expect(subscribeCoordinatorEvents).toHaveBeenCalled();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it('dispatches coordinatorEvent when handler is called', () => {
    let handler!: (event: CoordinatorEvent) => void;
    const subscribeCoordinatorEvents = vi.fn((fn: (event: CoordinatorEvent) => void) => {
      handler = fn;
      return () => {};
    });
    const dispatch = vi.fn();

    function Harness(): React.ReactElement {
      useAutonomousCoordinator(subscribeCoordinatorEvents, dispatch);
      return React.createElement(Text, null, 'test');
    }

    const view = render(React.createElement(Harness));

    handler({ type: 'goal:added', goalId: 'g1', title: 'Goal 1' });
    expect(dispatch).toHaveBeenCalledWith({
      type: 'coordinatorEvent',
      event: { type: 'goal:added', goalId: 'g1', title: 'Goal 1' },
    });

    view.unmount();
  });

  it('is a no-op when subscribeCoordinatorEvents is undefined', () => {
    const dispatch = vi.fn();

    function Harness(): React.ReactElement {
      useAutonomousCoordinator(undefined, dispatch);
      return React.createElement(Text, null, 'test');
    }

    const view = render(React.createElement(Harness));
    expect(dispatch).not.toHaveBeenCalled();
    view.unmount();
  });

  it('uses latest dispatch ref when dispatch changes', () => {
    let handler!: (event: CoordinatorEvent) => void;
    const subscribeCoordinatorEvents = vi.fn((fn: (event: CoordinatorEvent) => void) => {
      handler = fn;
      return () => {};
    });
    const dispatch1 = vi.fn();
    const dispatch2 = vi.fn();
    let currentDispatch = dispatch1;

    function Harness(): React.ReactElement {
      useAutonomousCoordinator(subscribeCoordinatorEvents, currentDispatch);
      return React.createElement(Text, null, 'test');
    }

    const view = render(React.createElement(Harness));

    handler({ type: 'goal:added', goalId: 'g1' });
    expect(dispatch1).toHaveBeenCalled();
    dispatch1.mockClear();

    // Update dispatch
    currentDispatch = dispatch2;
    view.rerender(React.createElement(Harness));

    handler({ type: 'goal:added', goalId: 'g2' });
    expect(dispatch2).toHaveBeenCalled();

    view.unmount();
  });
});
