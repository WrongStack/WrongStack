import type { EternalAutonomyEngine, ParallelEternalEngine } from '@wrongstack/core/execution';
import type { SddRunControl } from '@wrongstack/sdd';
import { useEffect } from 'react';
import type { Action, State } from '../app-reducer.js';

interface MutableRef<T> {
  current: T;
}

interface StreamSegment {
  kind: 'assistant' | 'thinking';
  text: string;
}

export interface SessionInterruptController {
  abortLeader: () => boolean;
  /**
   * True while a leader run, autonomy loop, or SDD run is in flight. Read by
   * `/clear` to confirm before wiping a session that still has active work.
   */
  isRunning?: (() => boolean) | undefined;
  /** TUI-owned `/clear` confirmation panel bridge. */
  confirmClear?:
    | ((info: { leaderActive: boolean; subagentCount: number }) => Promise<boolean>)
    | undefined;
  /** TUI-owned generic slash-command confirmation panel bridge. */
  confirmSlash?:
    | ((question: string, defaultYes: boolean) => Promise<boolean | null>)
    | undefined;
  resetSession?: (() => void) | undefined;
  waitForIdle?: (() => Promise<void>) | undefined;
}

interface UseSessionInterruptControllerOptions {
  interruptController: SessionInterruptController | undefined;
  dispatch: (action: Action) => void;
  stateRef: MutableRef<State>;
  activeCtrlRef: MutableRef<AbortController | null>;
  activeRunSettledRef: MutableRef<Promise<void>>;
  sessionGenerationRef: MutableRef<number>;
  streamingTextRef: MutableRef<string>;
  streamSegmentsRef: MutableRef<StreamSegment[]>;
  pendingDeltaRef: MutableRef<string>;
  assistantCommittedThisRunRef: MutableRef<boolean>;
  flushTimerRef: MutableRef<ReturnType<typeof setTimeout> | null>;
  eternalLoopRunningRef: MutableRef<boolean>;
  parallelLoopRunningRef: MutableRef<boolean>;
  /** Attachment preview cache — cleared on /clear so stale previews from
   *  the previous conversation don't survive into the next one. */
  tokenPreviewsRef: MutableRef<{ clear(): void }>;
  clearPendingConfirms: () => void;
  getEternalEngine: (() => EternalAutonomyEngine | null) | undefined;
  getParallelEngine: (() => ParallelEternalEngine | null) | undefined;
  getSddRun: (() => SddRunControl | null) | undefined;
  switchAutonomy:
    | ((mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => string | null)
    | undefined;
}

/** Connect `/interrupt` and `/clear` to the live TUI run lifecycle. */
export function useSessionInterruptController({
  interruptController,
  dispatch,
  stateRef,
  activeCtrlRef,
  activeRunSettledRef,
  sessionGenerationRef,
  streamingTextRef,
  streamSegmentsRef,
  pendingDeltaRef,
  assistantCommittedThisRunRef,
  flushTimerRef,
  eternalLoopRunningRef,
  parallelLoopRunningRef,
  tokenPreviewsRef,
  clearPendingConfirms,
  getEternalEngine,
  getParallelEngine,
  getSddRun,
  switchAutonomy,
}: UseSessionInterruptControllerOptions): void {
  useEffect(() => {
    if (!interruptController) return;

    let pendingClearResolve: ((decision: boolean) => void) | null = null;
    let pendingSlashResolve: ((decision: boolean | null) => void) | null = null;

    const confirmClear = (info: {
      leaderActive: boolean;
      subagentCount: number;
    }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        // There can only be one destructive clear prompt at a time. If a
        // second request somehow arrives, safely cancel the older waiter.
        pendingClearResolve?.(false);
        pendingClearResolve = resolve;
        dispatch({
          type: 'clearConfirmOpen',
          info: {
            ...info,
            value: '',
            resolve: (decision) => {
              if (pendingClearResolve !== resolve) return;
              pendingClearResolve = null;
              resolve(decision);
            },
          },
        });
      });

    const confirmSlash = (question: string, defaultYes: boolean): Promise<boolean | null> =>
      new Promise<boolean | null>((resolve) => {
        pendingSlashResolve?.(null);
        pendingSlashResolve = resolve;
        dispatch({
          type: 'slashConfirmOpen',
          info: {
            question,
            defaultYes,
            resolve: (decision) => {
              if (pendingSlashResolve !== resolve) return;
              pendingSlashResolve = null;
              resolve(decision);
            },
          },
        });
      });

    // Shared predicate: is any producer (leader run, autonomy loop, or SDD
    // run) still able to mutate the current session? `abortLeader` uses this
    // to decide what to stop; `isRunning` exposes it read-only so `/clear` can
    // confirm before wiping an active session.
    const isRunning = (): boolean => {
      const eternalEngine = getEternalEngine?.();
      const parallelEngine = getParallelEngine?.();
      const autonomyRunning =
        eternalLoopRunningRef.current ||
        parallelLoopRunningRef.current ||
        eternalEngine?.currentState === 'running' ||
        parallelEngine?.currentState === 'running';
      return (
        autonomyRunning ||
        (getSddRun?.()?.isRunning() ?? false) ||
        stateRef.current.status !== 'idle'
      );
    };

    const abortLeader = (): boolean => {
      let interrupted = false;
      const eternalEngine = getEternalEngine?.();
      const parallelEngine = getParallelEngine?.();
      const autonomyRunning =
        eternalLoopRunningRef.current ||
        parallelLoopRunningRef.current ||
        eternalEngine?.currentState === 'running' ||
        parallelEngine?.currentState === 'running';
      if (autonomyRunning) {
        eternalEngine?.stop();
        parallelEngine?.stop();
        switchAutonomy?.('off');
        interrupted = true;
      }

      const sddRun = getSddRun?.();
      if (sddRun?.isRunning()) {
        sddRun.stop();
        interrupted = true;
      }
      if (stateRef.current.status !== 'idle') {
        activeCtrlRef.current?.abort('user interrupt (/interrupt)');
        clearPendingConfirms();
        // Clear streaming refs immediately. The abort prevents
        // provider.response from firing (the response never completes), so
        // the normal turn-boundary cleanup in use-provider-event-bridge
        // won't run. Without this, partial segments and unflushed delta text
        // linger in the refs until the next successful run or /clear.
        streamingTextRef.current = '';
        streamSegmentsRef.current = [];
        pendingDeltaRef.current = '';
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        dispatch({ type: 'streamReset' });
        dispatch({ type: 'status', status: 'aborting' });
        interrupted = true;
      }
      return interrupted;
    };

    const resetSession = (): void => {
      sessionGenerationRef.current += 1;
      streamingTextRef.current = '';
      streamSegmentsRef.current = [];
      pendingDeltaRef.current = '';
      assistantCommittedThisRunRef.current = false;
      tokenPreviewsRef.current.clear();
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      dispatch({ type: 'streamReset' });
      dispatch({ type: 'toolStreamClear' });
      dispatch({ type: 'queueClear' });
      clearPendingConfirms();
    };

    interruptController.abortLeader = abortLeader;
    interruptController.isRunning = isRunning;
    interruptController.confirmClear = confirmClear;
    interruptController.confirmSlash = confirmSlash;
    interruptController.resetSession = resetSession;
    interruptController.waitForIdle = () => activeRunSettledRef.current;
    return () => {
      pendingClearResolve?.(false);
      pendingClearResolve = null;
      pendingSlashResolve?.(null);
      pendingSlashResolve = null;
      if (interruptController.abortLeader !== abortLeader) return;
      interruptController.abortLeader = () => false;
      interruptController.isRunning = () => false;
      if (interruptController.confirmClear === confirmClear) {
        delete interruptController.confirmClear;
      }
      if (interruptController.confirmSlash === confirmSlash) {
        delete interruptController.confirmSlash;
      }
      interruptController.resetSession = () => {};
      interruptController.waitForIdle = async () => {};
    };
  }, [
    interruptController,
    dispatch,
    stateRef,
    clearPendingConfirms,
    getEternalEngine,
    getParallelEngine,
    getSddRun,
    switchAutonomy,
  ]);
}
