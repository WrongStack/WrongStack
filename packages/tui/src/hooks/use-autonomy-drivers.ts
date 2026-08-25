import { toErrorMessage } from '@wrongstack/core/utils';
import {
  type Dispatch,
  type MutableRefObject,
  useEffect,
  useRef,
} from 'react';
import type { AppProps } from '../app-props.js';
import type { Action } from '../app-action-type.js';
import type { AutonomyStage } from './use-statusline-state.js';

interface AutonomyDriversOptions {
  getEternalEngine: AppProps['getEternalEngine'];
  getParallelEngine: AppProps['getParallelEngine'];
  getAutonomy: AppProps['getAutonomy'];
  switchAutonomy: AppProps['switchAutonomy'];
  subscribeEternalIteration: AppProps['subscribeEternalIteration'];
  subscribeEternalStage: AppProps['subscribeEternalStage'];
  refreshGoalSummary: () => void;
  autonomyLive: AutonomyStage;
  setAutonomyLive: (value: AutonomyStage) => void;
  dispatch: Dispatch<Action>;
  eternalLoopRunningRef: MutableRefObject<boolean>;
  parallelLoopRunningRef: MutableRefObject<boolean>;
}

/** Time (ms) the eternal/parallel driver sleeps between iterations so the
 *  loop never spins hot; also lets /autonomy stop and SIGINT land between
 *  iterations. Kept as a named constant so the yield density is explicit and
 *  verifiable (a driver loop must never run at zero delay). */
const BETWEEN_ITERATION_YIELD_MS = 200;

/** Yield between driver iterations. Centralizes the single unwind point so the
 *  density (and the guarantee that it can never silently become a busy-spin)
 *  is defined in exactly one place. */
function yieldBetweenIterations(ms: number = BETWEEN_ITERATION_YIELD_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Owns eternal and parallel-eternal loop drivers plus their live event bridges. */
export function useAutonomyDrivers({
  getEternalEngine,
  getParallelEngine,
  getAutonomy,
  switchAutonomy,
  subscribeEternalIteration,
  subscribeEternalStage,
  refreshGoalSummary,
  autonomyLive,
  setAutonomyLive,
  dispatch,
  eternalLoopRunningRef,
  parallelLoopRunningRef,
}: AutonomyDriversOptions): {
  runEternalLoopRef: MutableRefObject<() => Promise<void>>;
  runParallelLoopRef: MutableRefObject<() => Promise<void>>;
} {
  // Unmount guard. The driver loops below only exit on autonomy-mode flip or
  // engine-stopped — NOT on unmount. On a session-switch that leaves autonomy
  // at 'eternal', a loop would keep calling engine.runOneIteration() and
  // dispatching into a torn-down tree, retaining the engine closure forever.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Eternal-mode driver. Loops `engine.runOneIteration()` until autonomy
   * flips away from 'eternal' or the engine reports stopped state. Each
   * iteration appends an info entry summarizing what happened so the TUI
   * timeline shows the engine's activity. Runs as a single sequential
   * consumer of `agent.run` — no race with user submissions because user
   * input is gated by `state.status` (a running iteration keeps status
   * at 'running' until the agent.run inside the engine returns).
   */
  const runEternalLoop = async (): Promise<void> => {
    const engine = getEternalEngine?.();
    if (!engine) return;
    // Avoid double-driving if the loop is already running. Status will
    // bounce idle↔running per iteration; the autonomy flag is the source
    // of truth for "should we keep going".
    if (eternalLoopRunningRef.current) return;
    eternalLoopRunningRef.current = true;
    try {
      while (true) {
        // Stop immediately if the component unmounted mid-session (session
        // switch/exit) — otherwise the loop outlives the tree.
        if (!mountedRef.current) break;
        // Re-check the live state every iteration — /autonomy stop, SIGINT,
        // or /goal clear could have flipped it during the prior iteration.
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          // Per-iteration entries land via the subscribeEternalIteration
          // useEffect below — we don't need to log here. Only surface
          // *errors* the engine catches but doesn't journal.
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[eternal] ${toErrorMessage(err)}`,
            },
          });
        }
        // The await above may have resolved after unmount — don't dispatch
        // into a torn-down tree or start another iteration.
        if (!mountedRef.current) break;
        dispatch({ type: 'status', status: 'idle' });
        // Yield so a slash command submitted between iterations (e.g.
        // /autonomy stop) actually lands before we kick the next one.
        await yieldBetweenIterations();
      }
    } finally {
      eternalLoopRunningRef.current = false;
      // Skip the UI-syncing tail if we exited because of unmount — those
      // dispatches/setState calls would target a torn-down tree.
      if (mountedRef.current) {
        // Refresh goal summary — the engine may have cleared or completed
        // the goal autonomously (via [GOAL_COMPLETE] or [goal clear] marker
        // in the LLM output). Without this the status bar goal chip stays
        // visible with stale data.
        refreshGoalSummary();
        // If the engine stopped because the goal was cleared or completed
        // (not because the user typed /autonomy stop), the autonomy mode
        // stays at 'eternal' — switch to a sensible resting state so the
        // status bar doesn't show "ETERNAL" with no goal running.
        if (engine.currentState === 'stopped') {
          switchAutonomy?.('off');
        }
        // Sync the displayed autonomy state with reality. The loop only exits
        // when getAutonomy() !== 'eternal' or engine.currentState === 'stopped',
        // both of which mean the mode is effectively off/idle. Refreshing here
        // stops the status bar from oscillating between "● thinking…" and
        // "● idle" forever after the goal is done.
        if (getAutonomy) {
          const finalMode = getAutonomy();
          if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
        }
      }
    }
  };
  const runEternalLoopRef = useRef(runEternalLoop);
  runEternalLoopRef.current = runEternalLoop;

  /** Parallel-eternal driver — fan-out loop for the ParallelEternalEngine. */
  const runParallelLoop = async (): Promise<void> => {
    const engine = getParallelEngine?.();
    if (!engine) return;
    if (parallelLoopRunningRef.current) return;
    parallelLoopRunningRef.current = true;
    try {
      while (true) {
        if (!mountedRef.current) break;
        const liveMode = getAutonomy?.() ?? 'off';
        if (liveMode !== 'eternal-parallel') break;
        if (engine.currentState === 'stopped') break;
        dispatch({ type: 'status', status: 'running' });
        try {
          await engine.runOneIteration();
        } catch (err) {
          dispatch({
            type: 'addEntry',
            entry: {
              kind: 'error',
              text: `[parallel] ${toErrorMessage(err)}`,
            },
          });
        }
        if (!mountedRef.current) break;
        dispatch({ type: 'status', status: 'idle' });
        await yieldBetweenIterations();
      }
    } finally {
      parallelLoopRunningRef.current = false;
      if (mountedRef.current) {
        refreshGoalSummary();
        if (engine.currentState === 'stopped') {
          switchAutonomy?.('off');
        }
        if (getAutonomy) {
          const finalMode = getAutonomy();
          if (finalMode !== autonomyLive) setAutonomyLive(finalMode);
        }
      }
    }
  };
  const runParallelLoopRef = useRef(runParallelLoop);
  runParallelLoopRef.current = runParallelLoop;

  // Subscribe to live per-iteration events from the eternal engine. The
  // engine's loop drive (runEternalLoop above) emits "iteration completed"
  // info entries, but those are coarse — this subscription surfaces the
  // *actual* journal entry per iteration with source, status, and cost.
  // Without it the TUI timeline only shows one-line summaries; with it the
  // user sees `#42 ✓ [todo] refactor parser ($0.0034)`.
  useEffect(() => {
    if (!subscribeEternalIteration) return;
    const unsub = subscribeEternalIteration((entry) => {
      const mark =
        entry.status === 'success'
          ? '✓'
          : entry.status === 'failure'
            ? '✗'
            : entry.status === 'aborted'
              ? '⊘'
              : '·';
      const cost = typeof entry.costUsd === 'number' ? ` ($${entry.costUsd.toFixed(4)})` : '';
      const note = entry.note ? ` — ${entry.note.slice(0, 80)}` : '';
      const text = `#${entry.iteration} ${mark} [${entry.source}] ${entry.task}${cost}${note}`;
      dispatch({ type: 'addEntry', entry: { kind: 'info', text } });
    });
    return unsub;
  }, [subscribeEternalIteration]);

  // Subscribe to live stage-transition events from the eternal engine.
  // Drives `state.eternalStage` used by the status bar to show the
  // engine's current location (decide → execute → reflect → sleep/paused).
  useEffect(() => {
    if (!subscribeEternalStage) return;
    const unsub = subscribeEternalStage((stage) => {
      dispatch({ type: 'eternalStage', stage });
    });
    return unsub;
  }, [subscribeEternalStage]);

  return { runEternalLoopRef, runParallelLoopRef };
}
