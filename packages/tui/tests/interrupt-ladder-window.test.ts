// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const killAll = vi.fn(() => [] as string[]);
vi.mock('@wrongstack/tools', () => ({
  getProcessRegistry: () => ({ killAll, activeBackgroundCount: 0 }),
}));

import { useInterruptLadder } from '../src/hooks/use-interrupt-ladder.js';
import { createTestState } from './helpers/create-test-state.js';

/**
 * The bug this pins: the ladder's press counter was only reset by submit
 * and run start — no time window. A single Ctrl+C from 20 minutes ago
 * (cancelling a picker, say) plus one now read as the SECOND press:
 * killAll({force: true}) + exit(130) out of nowhere. run-tui.ts answers
 * the same "rapid repeat?" question with RAPID_EXIT_WINDOW_MS = 2s; the
 * ladder now expires idle-time presses on the same clock — but NEVER
 * during running/streaming/aborting, where the earlier press is part of
 * the same escape attempt and expiry would strand the user in a wedged
 * abort.
 */
describe('interrupt ladder stale-press window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    killAll.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeOptions(status: 'idle' | 'aborting') {
    const state = createTestState({ status });
    const exit = vi.fn();
    const onExit = vi.fn();
    const dispatch = vi.fn();
    const options = {
      stateRef: { current: state },
      exitRequestedRef: { current: false },
      agent: { ctx: { session: {} } } as never,
      liveDirector: () => null,
      onExit,
      exit,
      dispatch,
      activeCtrlRef: { current: null },
      clearPendingConfirms: vi.fn(),
      getEternalEngine: undefined,
      getParallelEngine: undefined,
      eternalLoopRunningRef: { current: false },
      parallelLoopRunningRef: { current: false },
      switchAutonomy: undefined,
      getSddRun: undefined,
      confirmExitRef: { current: false },
    };
    return { options: options as never as Parameters<typeof useInterruptLadder>[0], exit, onExit };
  }

  it('expires a stale idle-time press instead of force-exiting', () => {
    const { options, exit, onExit } = makeOptions('idle');
    const { result, unmount } = renderHook(() => useInterruptLadder(options));

    act(() => result.current.runInterruptLadder());
    expect(result.current.interruptsSyncRef.current).toBe(1);
    expect(exit).not.toHaveBeenCalled();

    // 20 "minutes" later, another press while idle must count as a FIRST
    // press again — not trigger the force-exit stage.
    vi.advanceTimersByTime(20 * 60 * 1000);
    act(() => result.current.runInterruptLadder());
    expect(result.current.interruptsSyncRef.current).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    expect(onExit).not.toHaveBeenCalled();
    expect(killAll).not.toHaveBeenCalledWith(expect.objectContaining({ force: true }));

    // A rapid second press (inside the window) still escalates to exit.
    vi.advanceTimersByTime(500);
    act(() => result.current.runInterruptLadder());
    expect(result.current.interruptsSyncRef.current).toBe(2);
    expect(onExit).toHaveBeenCalledWith(130);
    expect(exit).toHaveBeenCalled();
    expect(killAll).toHaveBeenCalledWith({ force: true, preserveBackground: true });
    unmount();
  });

  it('never expires the press while a run is aborting (wedged-abort escape hatch)', () => {
    const { options, exit, onExit } = makeOptions('aborting');
    const { result, unmount } = renderHook(() => useInterruptLadder(options));

    act(() => result.current.runInterruptLadder());
    expect(result.current.interruptsSyncRef.current).toBe(1);

    // The abort has been wedged for well past the window; the second press
    // must still exit — that is the entire purpose of the second stage.
    vi.advanceTimersByTime(30_000);
    act(() => result.current.runInterruptLadder());
    expect(result.current.interruptsSyncRef.current).toBe(2);
    expect(onExit).toHaveBeenCalledWith(130);
    expect(exit).toHaveBeenCalled();
    unmount();
  });
});
