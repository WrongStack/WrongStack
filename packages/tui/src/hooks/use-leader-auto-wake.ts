import type { EventBus } from '@wrongstack/contracts/kernel';
import type { ContentBlock } from '@wrongstack/contracts/types';
import type { LeaderWakePort } from '@wrongstack/core/coordination';
import { useEffect, useRef } from 'react';
import type { TuiLeaderAutoWake } from '../app-props.js';
import type { Action, State } from '../app-reducer.js';
import type { RunBlocksOptions } from '../tui-host-capabilities.js';

interface Cell<T> {
  current: T;
}

export interface TuiLeaderWakePortDeps {
  getSessionId(): string | undefined;
  activeController: Cell<AbortController | null>;
  eternalLoopRunning: Cell<boolean>;
  parallelLoopRunning: Cell<boolean>;
  enhanceAbort?: Cell<AbortController | null> | undefined;
  state: Cell<Pick<State, 'queue' | 'confirmQueue'>>;
  /** Open structured user-input forms (user.input_requested not yet resolved). */
  pendingForms: Cell<number>;
  runBlocks: Cell<(blocks: ContentBlock[], opts?: RunBlocksOptions) => Promise<void>>;
}

function normalizeSessionId(sessionId: string | undefined): string {
  return (sessionId ?? '').trim().replace(/\\/g, '/');
}

/**
 * The foreground TUI's wake port. The TUI shows exactly one session — the
 * agent's current one — so open and displayed both mean "is that session".
 * Idle is the race-free busy signal `runBlocks` itself uses (the controller
 * cell), plus the autonomy loop drivers that call the engine directly.
 */
export function createTuiLeaderWakePort(deps: TuiLeaderWakePortDeps): LeaderWakePort {
  const isForeground = (sessionId: string): boolean => {
    const current = normalizeSessionId(deps.getSessionId());
    return current.length > 0 && current === normalizeSessionId(sessionId);
  };
  return {
    isOpen: isForeground,
    isDisplayed: isForeground,
    isIdle: (sessionId) =>
      isForeground(sessionId) &&
      deps.activeController.current == null &&
      !deps.eternalLoopRunning.current &&
      !deps.parallelLoopRunning.current &&
      deps.state.current.queue.length === 0,
    hasPendingUserInput: () =>
      deps.state.current.queue.length > 0 || deps.enhanceAbort?.current != null,
    isConfirmPending: () =>
      deps.state.current.confirmQueue.length > 0 || deps.pendingForms.current > 0,
    startWakeTurn: async (_sessionId, prompt) => {
      // Not awaited: `runBlocks` claims the controller cell synchronously, so
      // the port reads busy at once; awaiting would hold the controller's
      // in-flight flag across the whole turn and its own post-run check.
      void deps.runBlocks.current([{ type: 'text', text: prompt }], { origin: 'auto_wake' });
    },
  };
}

export interface UseLeaderAutoWakeArgs extends Omit<TuiLeaderWakePortDeps, 'pendingForms'> {
  leaderAutoWake?: TuiLeaderAutoWake | undefined;
  events: EventBus;
  dispatch(action: Action): void;
}

/**
 * Bind the auto-wake controller to the foreground TUI session and surface its
 * activity in history: a notice line when a wake fires (the turn's own
 * turn-summary line carries its token/cost), and a warning when the chain cap
 * holds results until the user sends a message.
 */
export function useLeaderAutoWake(args: UseLeaderAutoWakeArgs): void {
  const argsRef = useRef(args);
  argsRef.current = args;
  const pendingForms = useRef(0);
  const { leaderAutoWake, events } = args;

  useEffect(() => {
    if (!leaderAutoWake) return;
    const live = argsRef;
    const port = createTuiLeaderWakePort({
      getSessionId: () => live.current.getSessionId(),
      activeController: live.current.activeController,
      eternalLoopRunning: live.current.eternalLoopRunning,
      parallelLoopRunning: live.current.parallelLoopRunning,
      enhanceAbort: live.current.enhanceAbort,
      state: live.current.state,
      pendingForms,
      runBlocks: live.current.runBlocks,
    });
    const detach = leaderAutoWake.attachPort(port);
    const isMine = (sessionId: string | undefined) =>
      normalizeSessionId(sessionId) === normalizeSessionId(live.current.getSessionId());
    const offs = [
      events.on('user.input_requested', () => {
        pendingForms.current += 1;
      }),
      events.on('user.input_resolved', () => {
        pendingForms.current = Math.max(0, pendingForms.current - 1);
      }),
      events.on('leader.auto_wake_started', (e) => {
        if (!isMine(e.sessionId)) return;
        const n = e.delegationIds.length;
        live.current.dispatch({
          type: 'addEntry',
          entry: {
            kind: 'info',
            text: `⟳ auto-wake: ${n} background delegation result${n === 1 ? '' : 's'} arrived (${e.delegationIds.join(', ')}) — starting a new turn (woken turn ${e.chain} without your input; it spends tokens like any turn).`,
          },
        });
      }),
      events.on('leader.auto_wake_suppressed', (e) => {
        if (!isMine(e.sessionId) || e.reason !== 'chain_cap') return;
        live.current.dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `auto-wake paused: ${e.pending} background result${e.pending === 1 ? '' : 's'} held after too many consecutive woken turns — send any message to receive ${e.pending === 1 ? 'it' : 'them'}.`,
          },
        });
      }),
    ];
    // Results that arrived while no port was bound (boot, remount) get their
    // wake now that the session is shown.
    try {
      const sessionId = live.current.getSessionId();
      if (sessionId) leaderAutoWake.onSessionDisplayed(sessionId);
    } catch {
      /* best-effort */
    }
    return () => {
      for (const off of offs) off();
      detach();
    };
  }, [leaderAutoWake, events]);
}
