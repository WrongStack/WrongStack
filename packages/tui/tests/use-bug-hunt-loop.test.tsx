// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type Action, reducer } from '../src/app-reducer.js';
import { useBugHuntLoop } from '../src/hooks/use-bug-hunt-loop.js';
import { createTestState } from './helpers/create-test-state.js';

describe('useBugHuntLoop', () => {
  it('keeps the original 25-round budget across re-submissions and never opens a 26th prompt', () => {
    const dispatch = vi.fn<(action: Action) => void>();
    const submit = vi.fn<(command: string) => void>();
    const command = '/bughunt --rounds 25 packages/tui';
    const { result } = renderHook(() => useBugHuntLoop(dispatch, submit));

    act(() => result.current.onBugHuntStarted(command, 25));
    expect(dispatch).toHaveBeenCalledWith({
      type: 'bugHuntRunningOpen',
      info: { currentRound: 1, totalRounds: 25 },
    });

    for (let round = 1; round < 25; round++) {
      act(() => result.current.onRunFinished('done'));
      const open = dispatch.mock.calls
        .map(([action]) => action)
        .filter((action) => action.type === 'bugHuntContinueOpen')
        .at(-1);
      expect(open).toMatchObject({
        type: 'bugHuntContinueOpen',
        info: { completedRounds: round, totalRounds: 25 },
      });

      act(() => open?.info.resolve('yes'));
      const continuation = `This is round ${round + 1}/25; we're continuing the bug hunt. Stay within the original scope: packages/tui.`;
      expect(submit).toHaveBeenLastCalledWith(continuation);
      expect(result.current.consumeReplay(continuation)).toBe(true);
      expect(result.current.consumeReplay(continuation)).toBe(false);
      expect(dispatch).toHaveBeenCalledWith({
        type: 'bugHuntRunningOpen',
        info: { currentRound: round + 1, totalRounds: 25 },
      });
    }

    act(() => result.current.onRunFinished('done'));

    expect(submit).toHaveBeenCalledTimes(24);
    expect(submit).toHaveBeenNthCalledWith(
      24,
      "This is round 25/25; we're continuing the bug hunt. Stay within the original scope: packages/tui.",
    );
    expect(dispatch).toHaveBeenCalledWith({
      type: 'addEntry',
      entry: {
        kind: 'info',
        text: 'Proof-Driven Bug Hunter completed 25/25 requested rounds.',
      },
    });
    expect(
      dispatch.mock.calls
        .map(([action]) => action)
        .filter((action) => action.type === 'bugHuntContinueOpen'),
    ).toHaveLength(24);
    expect(
      dispatch.mock.calls
        .map(([action]) => action)
        .filter((action) => action.type === 'bugHuntRunningOpen'),
    ).toHaveLength(25);
    expect(
      dispatch.mock.calls
        .map(([action]) => action)
        .filter((action) => action.type === 'bugHuntRunningClose'),
    ).toHaveLength(25);
  });

  it('continues an unscoped multi-round hunt without repeating the slash command', () => {
    const dispatch = vi.fn<(action: Action) => void>();
    const submit = vi.fn<(command: string) => void>();
    const { result } = renderHook(() => useBugHuntLoop(dispatch, submit));

    act(() => result.current.onBugHuntStarted('/bughunt --rounds 3', 3));
    act(() => result.current.onRunFinished('done'));
    const open = dispatch.mock.calls
      .map(([action]) => action)
      .find((action) => action.type === 'bugHuntContinueOpen');

    act(() => open?.info.resolve('yes'));

    const continuation = "This is round 2/3; we're continuing the bug hunt.";
    expect(submit).toHaveBeenCalledWith(continuation);
    expect(result.current.consumeReplay(continuation)).toBe(true);
  });

  // Regression: /clear must end the hunt. The reducer half (bugHuntRunning /
  // bugHuntContinue) is reset by 'clearHistory', but the hook's refs live
  // outside the reducer — and a mid-round /clear bumps sessionGeneration so
  // run-blocks-controller drops the in-flight run BEFORE onRunFinished fires.
  // Without the historyGen-reactive reset, shouldSuppressNextSteps() stayed
  // true forever (silently disabling next-steps suggestions/predictions) and
  // an armed replay marker could swallow the echo of the user's next
  // identical command. App passes state.historyGen; a bump resets both refs.
  it('resets the active hunt and pending replay when /clear bumps historyGen', () => {
    let state = createTestState();
    const dispatch = (action: Action): void => {
      state = reducer(state, action);
    };
    const submitted: string[] = [];
    const command = '/bughunt packages/tui';
    const initialGen = state.historyGen;

    const { result, rerender } = renderHook(
      ({ gen }: { gen: number }) =>
        useBugHuntLoop(
          dispatch,
          (cmd) => {
            submitted.push(cmd);
          },
          gen,
        ),
      { initialProps: { gen: initialGen } },
    );

    act(() => result.current.onBugHuntStarted(command, 3));
    expect(result.current.shouldSuppressNextSteps()).toBe(true);

    // Round done → continue panel → user answers, arming the replay.
    act(() => result.current.onRunFinished('done'));
    act(() => state.bugHuntContinue?.resolve('yes'));
    expect(submitted).toEqual([
      "This is round 2/3; we're continuing the bug hunt. Stay within the original scope: packages/tui.",
    ]);

    // /clear (real reducer) + the App re-render carrying the bumped generation.
    act(() => dispatch({ type: 'clearHistory' }));
    expect(state.bugHuntRunning).toBeNull();
    expect(state.bugHuntContinue).toBeNull();
    act(() => rerender({ gen: state.historyGen }));

    expect(result.current.shouldSuppressNextSteps()).toBe(false);
    expect(result.current.consumeReplay(command)).toBe(false);

    // A fresh hunt after /clear starts at round 1 with no stale budget.
    act(() => result.current.onBugHuntStarted(command, 3));
    expect(state.bugHuntRunning?.currentRound).toBe(1);
  });
});
