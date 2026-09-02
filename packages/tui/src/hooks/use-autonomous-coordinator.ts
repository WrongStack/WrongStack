import { useCallback, useEffect, useRef } from 'react';
import type { CoordinatorEvent } from '@wrongstack/core/coordination';

/**
 * Wires the AutonomousCoordinator into the TUI reducer via dispatch.
 *
 * When `subscribeCoordinatorEvents` is provided, this hook:
 * 1. Subscribes to all coordinator events on mount
 * 2. Maps each CoordinatorEvent to a `coordinatorEvent` dispatch action
 * 3. Cleans up the subscription on unmount
 *
 * When the option is omitted (coordinator not active), the hook is a no-op.
 *
 * @param subscribeCoordinatorEvents - the TUI's subscribe function from RunTuiOptions
 * @param dispatch - the TUI reducer dispatch
 */
export function useAutonomousCoordinator(
  subscribeCoordinatorEvents: ((fn: (event: CoordinatorEvent) => void) => () => void) | undefined,
  dispatch: React.Dispatch<
    { type: 'coordinatorEvent'; event: CoordinatorEvent } | { type: 'toggleCoordinatorMonitor' }
  >,
): void {
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  const handler = useCallback((event: CoordinatorEvent) => {
    dispatchRef.current({
      type: 'coordinatorEvent',
      event,
    });
  }, []);

  useEffect(() => {
    if (!subscribeCoordinatorEvents) return;
    const unsubscribe = subscribeCoordinatorEvents(handler);
    return unsubscribe;
  }, [subscribeCoordinatorEvents, handler]);
}
