/**
 * Goal event forwarding — extracted from the TUI branch of execute().
 *
 * Subscribes to PhaseOrchestrator events on the main EventBus and forwards
 * them to a TUI handler so the PhaseMonitor/PhasePanel stay in sync with
 * the running graph. The event list is static; the only runtime input is
 * the EventBus instance.
 *
 * Returns a subscribe function (called by runTui) and a cleanup function
 * (called on TUI teardown).
 */
import { PHASE_EVENT_NAMES } from '@wrongstack/core/goal';
import type { EventBus } from '@wrongstack/core/kernel';

/**
 * The full set of events forwarded from the EventBus to the TUI's
 * Goal/Coordinator/Worktree/Countdown monitors.
 *
 * Imported from `@wrongstack/core`'s `PHASE_EVENT_NAMES` const array so the
 * compiler catches drift when events are added or renamed.
 */
const GOAL_EVENTS: readonly string[] = [
  ...PHASE_EVENT_NAMES,
  // Extra events not in PhaseEventMap (sourced from other subsystems)
  'sdd.board.snapshot',
  'worktree.allocated',
  'worktree.committed',
  'worktree.merged',
  'worktree.conflict',
  'worktree.released',
  'worktree.failed',
  'countdown.tick',
];

interface GoalWiring {
  /**
   * Called by the TUI to receive forwarded events. Each call registers
   * one listener per event name; the returned function unregisters all.
   */
  subscribe: (handler: (event: string, payload: unknown) => void) => () => void;
  /** Remove all listeners. Safe to call multiple times. */
  cleanup: () => void;
}

/**
 * Wire Goal event forwarding on the given EventBus.
 *
 * Goal events are emitted on the untyped surface of the bus (the
 * orchestrator casts `emit` to a string-keyed signature), so we subscribe
 * through the same untyped view rather than the typed event-name overloads.
 *
 * Bind to `events` — pulling the method off the bus as a bare reference
 * loses `this`, so `on`/`off` would read `this.listeners` off `undefined`
 * and throw the moment Goal subscribes.
 */
export function wireGoal(events: EventBus): GoalWiring {
  const handlers = new Map<string, (payload: unknown) => void>();

  const onUntyped = events.on.bind(events) as never as (
    event: string,
    handler: (payload: unknown) => void,
  ) => void;
  const offUntyped = events.off.bind(events) as never as (
    event: string,
    handler: (payload: unknown) => void,
  ) => void;

  const subscribe = (handler: (event: string, payload: unknown) => void): (() => void) => {
    const registrations: Array<() => void> = [];
    for (const ev of GOAL_EVENTS) {
      const h = (p: unknown) => handler(ev, p);
      handlers.set(ev, h);
      onUntyped(ev, h);
      registrations.push(() => offUntyped(ev, h));
    }
    return () => {
      for (const unregister of registrations) unregister();
      handlers.clear();
    };
  };

  const cleanup = (): void => {
    for (const [ev, h] of handlers) {
      offUntyped(ev, h);
    }
    handlers.clear();
  };

  return { subscribe, cleanup };
}
