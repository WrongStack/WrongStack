import type { Director } from '@wrongstack/core/coordination';
import { getProcessRegistry } from '@wrongstack/tools';
import { type Dispatch, type MutableRefObject, useCallback, useEffect, useRef } from 'react';
import type { AppProps } from '../app-props.js';
import type { Action } from '../app-action-type.js';
import type { State } from '../app-state.js';

interface InterruptLadderOptions {
  stateRef: MutableRefObject<State>;
  exitRequestedRef: MutableRefObject<boolean>;
  agent: AppProps['agent'];
  liveDirector: () => Director | null | undefined;
  onExit: AppProps['onExit'];
  exit: () => void;
  dispatch: Dispatch<Action>;
  activeCtrlRef: MutableRefObject<AbortController | null>;
  clearPendingConfirms: () => void;
  getEternalEngine: AppProps['getEternalEngine'];
  getParallelEngine: AppProps['getParallelEngine'];
  eternalLoopRunningRef: MutableRefObject<boolean>;
  parallelLoopRunningRef: MutableRefObject<boolean>;
  switchAutonomy: AppProps['switchAutonomy'];
  getSddRun: AppProps['getSddRun'];
  confirmExitRef: MutableRefObject<boolean>;
}

/**
 * How long a Ctrl+C press stays "live" for the escalation ladder while the
 * session is idle. Mirrors run-tui.ts's RAPID_EXIT_WINDOW_MS — the two
 * counters answer the same "was this a rapid repeat?" question and should
 * expire on the same clock.
 */
const INTERRUPT_PRESS_WINDOW_MS = 2_000;

/** Implements the synchronous three-stage Ctrl+C/SIGINT escalation ladder. */
export function useInterruptLadder({
  stateRef,
  exitRequestedRef,
  agent,
  liveDirector,
  onExit,
  exit,
  dispatch,
  activeCtrlRef,
  clearPendingConfirms,
  getEternalEngine,
  getParallelEngine,
  eternalLoopRunningRef,
  parallelLoopRunningRef,
  switchAutonomy,
  getSddRun,
  confirmExitRef,
}: InterruptLadderOptions): {
  interruptsSyncRef: MutableRefObject<number>;
  runInterruptLadder: () => void;
} {
  // Synchronous Ctrl+C press counter for the escalation ladder. The reducer's
  // `state.interrupts` is display/UI state — it only updates on a React
  // re-render, so two rapid presses (or ANY presses while the tree is busy
  // re-rendering a wedged 'aborting' run — exactly when the user is hammering
  // Ctrl+C) would BOTH read 0 and both take the "first press" branch, and the
  // exit stage would never fire. This ref is the source of truth for the
  // ladder stage; the dispatches below keep the UI state in sync.
  const interruptsSyncRef = useRef(0);
  // Timestamp of the previous press, for stale-press expiry below.
  const lastPressAtRef = useRef(0);

  // The Ctrl+C escalation ladder, as a callable — three stages:
  //   1st press — stop work and stay at the prompt: cancel the foreground
  //     run + kill the fleet, OR (in autonomy / background-only mode) halt
  //     the engines + terminate the fleet. Pickers cancel instead.
  //   2nd press — exit: graceful Ink unmount (restores the terminal) with a
  //     hard-exit fallback timer in case the React tree is wedged.
  //   3rd press — immediate process.exit, so a wedged Ink loop can't trap
  //     the user.
  // Invoked from TWO entry points: the process SIGINT listener (external
  // signals, and terminals that deliver Ctrl+C as a signal) and handleKey's
  // top-of-function intercept — raw-mode terminals (ConPTY/Windows, and any
  // tty in raw mode) deliver Ctrl+C as KEY DATA and never generate SIGINT,
  // so without the key-data route the whole ladder is unreachable from the
  // keyboard there.
  const runInterruptLadder = useCallback(() => {
    const current = stateRef.current;
    // Stale-press expiry. The counter is otherwise only reset by submit and
    // run start, so a single Ctrl+C from 20 minutes ago (say, cancelling a
    // picker) plus one now would read as the SECOND press and force-exit
    // with killAll — run-tui.ts answers the same question with
    // RAPID_EXIT_WINDOW_MS. The expiry applies ONLY while idle: during
    // running/streaming/aborting the earlier press is part of the same
    // escape attempt, and expiring it would strand the user in a wedged
    // 'aborting' run that takes longer than the window (the exact case the
    // 2nd-press-exits stage exists for).
    const now = Date.now();
    if (
      interruptsSyncRef.current > 0 &&
      current.status === 'idle' &&
      now - lastPressAtRef.current > INTERRUPT_PRESS_WINDOW_MS
    ) {
      interruptsSyncRef.current = 0;
      dispatch({ type: 'resetInterrupts' });
    }
    lastPressAtRef.current = now;
    const pressCount = interruptsSyncRef.current + 1;
    interruptsSyncRef.current = pressCount;
    // Second (or later) Ctrl+C — exit no matter what. Status may be
    // 'aborting', 'running', or 'streaming'; the user has clearly
    // decided they want out. Try Ink's graceful exit first, then
    // hard-exit on a short timer in case the React tree is wedged.
    if (pressCount >= 2) {
      // Second (or later) Ctrl+C — force-kill foreground children while
      // preserving explicitly detached background jobs.
      getProcessRegistry().killAll({ force: true, preserveBackground: true });
      // If we already asked Ink to unmount and the user pressed again, the
      // React tree is wedged — hard-exit immediately. Drain the session
      // writer synchronously first so the aborted run's last events
      // survive on disk (process.exit skips every async teardown path).
      if (exitRequestedRef.current) {
        try {
          agent.ctx.session.flushSync?.();
        } catch {
          /* best-effort — exiting either way */
        }
        process.exit(130);
      }
      exitRequestedRef.current = true;
      dispatch({ type: 'interrupt' });
      // Terminate any lingering fleet so subagents don't outlive the TUI.
      {
        const dir = liveDirector();
        if (dir) void dir.terminateAll().catch(() => undefined);
      }
      // Graceful Ink unmount first: it restores the terminal (raw mode off,
      // cursor shown) and routes the 130 exit code
      // through run-tui's settle(). A bare process.exit() here would skip
      // that and can leave the terminal in raw mode — the "exit feels
      // broken" symptom. Fall back to a hard exit if Ink never unmounts.
      onExit(130);
      exit();
      const hardExit = setTimeout(() => {
        try {
          agent.ctx.session.flushSync?.();
        } catch {
          /* best-effort — exiting either way */
        }
        process.exit(130);
      }, 400);
      hardExit.unref?.();
      return;
    }
    dispatch({ type: 'interrupt' });

    // Pickers are safe to cancel outright — closing the overlay
    // restores the previous state cleanly with no side-effects.
    // Do this first so a single Ctrl+C from the model picker or
    // slash picker exits gracefully instead of doing nothing.
    if (current.authPanel.open) {
      // Closing the panel flips state.authPanel.open, which the
      // useAuthPanel close-effect observes to abort any in-flight flow
      // (OAuth loopback server, pending prompt) — no orphaned work.
      dispatch({ type: 'authClose' });
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Auth panel cancelled.' },
      });
      return;
    }
    if (current.modelPicker.open) {
      dispatch({ type: 'modelPickerClose' });
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Model picker cancelled.' },
      });
      return;
    }
    if (current.settingsPicker.open) {
      dispatch({ type: 'settingsClose' });
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Settings cancelled.' },
      });
      return;
    }
    if (current.slashPicker.open) {
      dispatch({ type: 'slashPickerClose' });
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: 'Cancelled.' },
      });
      return;
    }

    if (activeCtrlRef.current) {
      activeCtrlRef.current.abort('user interrupt (Ctrl+C)');
      clearPendingConfirms();
      dispatch({ type: 'status', status: 'aborting' });
      // Halt any autonomy driver / SDD run too, so it can't kick off the
      // NEXT iteration after this one aborts. Mirrors /interrupt's
      // abortLeader — a foreground run and background drivers can
      // coexist (e.g. a run submitted while an SDD run drains).
      {
        const eEng = getEternalEngine?.();
        const pEng = getParallelEngine?.();
        const autonomyRunning =
          eternalLoopRunningRef.current ||
          parallelLoopRunningRef.current ||
          eEng?.currentState === 'running' ||
          pEng?.currentState === 'running';
        if (autonomyRunning) {
          eEng?.stop();
          pEng?.stop();
          switchAutonomy?.('off');
        }
        const sdd = getSddRun?.();
        if (sdd?.isRunning()) sdd.stop();
      }
      // Kill every running subagent on the first interrupt — without
      // this the parent agent.run() stays parked in `await delegate
      // → director.awaitTasks` forever and the "press again to exit"
      // hint becomes a lie.
      //
      // We `await` terminateAll AND race a 1500ms cap so a stuck
      // bridge or hung tool can't trap us in cleanup — the user
      // pressed Ctrl+C; their patience is finite. The second
      // Ctrl+C still forces exit immediately via the path above,
      // so this race only matters for the polite-shutdown window.
      const ctrlCDir = liveDirector();
      if (ctrlCDir) {
        const cap = new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1500);
          t.unref?.();
        });
        void Promise.race([ctrlCDir.terminateAll().catch(() => undefined), cap]);
      }
      // Kill foreground bash/exec children. Detached background launches are
      // independent jobs and survive interruption/host exit by design.
      const processRegistry = getProcessRegistry();
      const killed = processRegistry.killAll({ preserveBackground: true });
      const procTag =
        killed.length > 0
          ? ` + killed ${killed.length} process${killed.length === 1 ? '' : 'es'}`
          : '';
      const preservedTag =
        processRegistry.activeBackgroundCount > 0
          ? ` + preserving ${processRegistry.activeBackgroundCount} background process${processRegistry.activeBackgroundCount === 1 ? '' : 'es'}`
          : '';
      const droppedCount = stateRef.current.queue.length;
      if (droppedCount > 0) {
        dispatch({ type: 'queueClear' });
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Iteration cancelled${ctrlCDir ? ' + fleet terminated' : ''}${procTag}${preservedTag}. Dropped ${droppedCount} queued message${droppedCount === 1 ? '' : 's'}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
          },
        });
      } else {
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `Iteration cancelled${ctrlCDir ? ' + fleet terminated' : ''}${procTag}${preservedTag}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
          },
        });
      }
    } else {
      // No foreground (runBlocks) controller. We may still have background
      // work with no AbortController of its own: an autonomy engine driving
      // iterations, or a fleet of subagents. Eternal/parallel loops never
      // set activeCtrlRef, so this branch is the ONLY place their Ctrl+C is
      // handled — the first press must actually stop that work (and return
      // to the prompt), not merely announce "press again to exit".
      const fleetRunning = Object.values(current.fleet).filter(
        (e) => e.status === 'running',
      ).length;
      const autonomyRunning =
        eternalLoopRunningRef.current ||
        parallelLoopRunningRef.current ||
        getEternalEngine?.()?.currentState === 'running' ||
        getParallelEngine?.()?.currentState === 'running';
      // A `/sdd parallel` run drives its own coordinator (not the autonomy
      // engines / director fleet), so it must be stopped explicitly here — it's
      // the only Ctrl+C path while the run blocks the prompt.
      const sddRun = getSddRun?.();
      const sddRunning = sddRun?.isRunning() ?? false;
      if (autonomyRunning || fleetRunning > 0 || sddRunning) {
        // Halt the engines first — eternal's stop() aborts the in-flight
        // iteration; both flip their persisted state to 'stopped'. Then
        // flip autonomy off so the driver loop won't start another
        // iteration, and terminate the fleet + tracked processes.
        getEternalEngine?.()?.stop();
        getParallelEngine?.()?.stop();
        if (sddRunning) sddRun?.stop();
        if (autonomyRunning) switchAutonomy?.('off');
        const bgDir = liveDirector();
        if (bgDir) {
          const cap = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 1500);
            t.unref?.();
          });
          void Promise.race([bgDir.terminateAll().catch(() => undefined), cap]);
        }
        const killed = getProcessRegistry().killAll({ preserveBackground: true });
        const bits: string[] = [];
        if (autonomyRunning) bits.push('autonomy stopped');
        if (sddRunning) bits.push('SDD run stopped');
        if (fleetRunning > 0)
          bits.push(`${fleetRunning} agent${fleetRunning === 1 ? '' : 's'} terminated`);
        if (killed.length > 0)
          bits.push(`${killed.length} process${killed.length === 1 ? '' : 'es'} killed`);
        dispatch({
          type: 'addEntry',
          entry: {
            kind: 'warn',
            text: `${bits.join(' + ') || 'Background work stopped'}. ${confirmExitRef.current ? 'Press Ctrl+C again to confirm exit.' : 'Press Ctrl+C again to exit.'}`,
          },
        });
        return;
      }
      // Truly idle — kill lingering foreground children and arm the
      // second-press exit. Detached background jobs remain alive.
      const processRegistry = getProcessRegistry();
      const killed = processRegistry.killAll({ preserveBackground: true });
      const procTag =
        killed.length > 0
          ? ` Killed ${killed.length} process${killed.length === 1 ? '' : 'es'}.`
          : '';
      const backgroundTag =
        processRegistry.activeBackgroundCount > 0
          ? ` Preserving ${processRegistry.activeBackgroundCount} background process${processRegistry.activeBackgroundCount === 1 ? '' : 'es'}.`
          : '';
      dispatch({
        type: 'addEntry',
        entry: { kind: 'warn', text: `Press Ctrl+C again to exit.${procTag}${backgroundTag}` },
      });
    }
  }, [
    agent,
    liveDirector,
    clearPendingConfirms,
    dispatch,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    switchAutonomy,
    onExit,
    exit,
  ]);

  // Route real SIGINTs (external kill, terminals that deliver Ctrl+C as a
  // signal) into the ladder. Keyboard Ctrl+C on raw-mode terminals arrives
  // as key data and enters via handleKey's intercept instead.
  useEffect(() => {
    process.on('SIGINT', runInterruptLadder);
    return () => {
      process.off('SIGINT', runInterruptLadder);
    };
  }, [runInterruptLadder]);

  return { interruptsSyncRef, runInterruptLadder };
}
