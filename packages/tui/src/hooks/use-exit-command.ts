import type { Director } from '@wrongstack/core/coordination';
import type { SlashCommand } from '@wrongstack/core/types';
import { getProcessRegistry } from '@wrongstack/tools';
import type { MutableRefObject } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import type { Action, State } from '../app-reducer.js';
import { createExitSlashCommand } from '../exit-slash.js';
import type { SessionInterruptController } from './use-session-interrupt-controller.js';

/**
 * Minimal structural type for the slash registry hooks use. The real
 * registry exports a richer `SlashCommand` interface, but this hook only
 * needs the registration API surface and accepts the command shape
 * implicitly via the factory we register.
 */
interface SlashRegistryLike {
  register(cmd: SlashCommand, owner?: string, opts?: { official?: boolean }): void;
  unregister(name: string): void;
  get?(name: string): SlashCommand | undefined;
}

interface UseExitCommandOptions {
  slashRegistry: SlashRegistryLike;
  dispatch: (action: Action) => void;
  /**
   * Reducer-mirrored snapshot of `state.exitConfirm`. Retained in the hook
   * contract so the caller owns the panel state explicitly; lifecycle
   * teardown is enforced by the awaited confirmation resolver rather than
   * by observing a later render.
   */
  exitConfirm: State['exitConfirm'];
  stateRef: MutableRefObject<State>;
  sessionGenerationRef: MutableRefObject<number>;
  interruptController?: SessionInterruptController | undefined;
  getDirector?: (() => Director | null | undefined) | undefined;
}

/**
 * Wire `/exit` to the TUI shell.
 *
 * Mirrors the `/clear` invariant: while a leader run or any subagent is in
 * flight, `/exit` must NOT terminate the TUI silently. It opens an
 * `exitConfirm` panel that requires explicit Enter/Esc acknowledgement.
 *
 * Once the user confirms, the hook bumps the session generation, aborts the
 * foreground leader plus autonomy/SDD drivers, and waits for both leader-idle
 * and fleet teardown behind a bounded 1500 ms grace window. This matches the
 * producer lifecycle used by `/interrupt` and `/clear`.
 * The slash dispatcher then observes `{ exit: true }` on the resolved
 * command and asks Ink to unmount; we deliberately do NOT call `exit()`
 * ourselves so there is exactly one graceful-unmount path.
 *
 * When no work is active, `confirmExit` resolves `true` without opening the
 * modal because there is no fleet teardown to await.
 *
 * The hook must be mounted exactly once from the App component.
 */
export function useExitCommand({
  slashRegistry,
  dispatch,
  stateRef,
  sessionGenerationRef,
  interruptController,
  getDirector,
}: UseExitCommandOptions): void {
  // Capture the host command before this hook replaces it. Keep the reference
  // across effect cleanup/re-registration (including React StrictMode) so the
  // TUI wrapper never loses the host-owned exit lifecycle.
  const hostExitCommandRef = useRef<SlashCommand | undefined>(undefined);
  const hostExitCapturedRef = useRef(false);
  if (!hostExitCapturedRef.current) {
    hostExitCommandRef.current = slashRegistry.get?.('exit');
    hostExitCapturedRef.current = true;
  }

  // One waiter at a time so a second `/exit` while the first is open
  // cannot strand the previous promise.
  const pendingResolveRef = useRef<((decision: boolean) => void) | null>(null);
  const terminateWork = useCallback(async (): Promise<void> => {
    // Invalidate late output first, then stop every producer that can still
    // mutate this session: foreground leader, autonomy/SDD drivers, and fleet.
    sessionGenerationRef.current += 1;
    interruptController?.abortLeader();

    const cleanup: Promise<unknown>[] = [];
    if (interruptController?.waitForIdle) {
      cleanup.push(interruptController.waitForIdle().catch(() => undefined));
    }
    const dir = getDirector?.();
    if (dir) cleanup.push(dir.terminateAll().catch(() => undefined));
    if (cleanup.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, 1500);
      timeout.unref?.();
    });
    // Bound the combined idle + fleet barrier so a provider that ignores its
    // abort signal or a wedged bridge cannot trap the user in `/exit`.
    try {
      await Promise.race([Promise.allSettled(cleanup).then(() => undefined), cap]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }, [getDirector, interruptController, sessionGenerationRef]);

  const confirmExit = useCallback(
    (info: {
      leaderActive: boolean;
      subagentCount: number;
      backgroundCount?: number | undefined;
    }): Promise<boolean> => {
      // If nothing is running, exit immediately — there is no lifecycle work
      // to await and no need to open the confirmation panel.
      if (!info.leaderActive && info.subagentCount === 0) {
        return Promise.resolve(true);
      }

      return new Promise<boolean>((resolve) => {
        pendingResolveRef.current?.(false);
        pendingResolveRef.current = resolve;
        dispatch({
          type: 'exitConfirmOpen',
          info: {
            leaderActive: info.leaderActive,
            subagentCount: info.subagentCount,
            ...(info.backgroundCount ? { backgroundCount: info.backgroundCount } : {}),
            resolve: (decision) => {
              if (pendingResolveRef.current !== resolve) return;
              pendingResolveRef.current = null;
              if (!decision) {
                resolve(false);
                return;
              }
              void terminateWork().then(
                () => resolve(true),
                () => resolve(true),
              );
            },
          },
        });
      });
    },
    [dispatch, terminateWork],
  );

  // Register `/exit`. Re-registered when the underlying closures change so
  // the slash command always sees the latest state-ref + director.
  useEffect(() => {
    const cmd = createExitSlashCommand({
      isLeaderActive: () =>
        interruptController?.isRunning?.() ?? stateRef.current.status !== 'idle',
      countRunningSubagents: () =>
        Object.values(stateRef.current.fleet).filter((e) => e.status === 'running').length,
      countBackgroundProcesses: () => getProcessRegistry().activeBackgroundCount,
      confirmExit,
      runExitLifecycle: hostExitCommandRef.current?.run.bind(hostExitCommandRef.current),
    });
    slashRegistry.register(cmd, 'use-exit-command', { official: true });
    return () => {
      slashRegistry.unregister('exit');
      if (hostExitCommandRef.current) slashRegistry.register(hostExitCommandRef.current);
    };
  }, [slashRegistry, stateRef, interruptController, confirmExit]);
}
