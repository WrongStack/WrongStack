import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { disposeStreakState, useAutoSubmitStreak } from '../../src/stores/auto-submit-streak.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionStore } from '../../src/stores/session-store.js';

/**
 * The auto-submit cap and the repetition guard are PER SESSION.
 *
 * Both lived in module-level variables that the session-change effect zeroed,
 * which meant clicking to another tab and back reset them: a run could sail
 * past `autoProceedMaxIterations`, and a prompt loop the guard had already
 * halted started over. Neither is a cosmetic counter — they are the two things
 * standing between an autonomous run and an unbounded one.
 */

function bind(sessionId: string) {
  act(() => {
    useSessionStore.getState().setSession({
      id: sessionId,
      startedAt: Date.now(),
      provider: 'test',
      model: 'test',
    });
  });
}

beforeEach(() => {
  useLocalPrefs.setState({ autonomy: 'auto', autoProceedMaxIterations: 3 } as never);
  for (const id of ['streak-tab-1', 'streak-tab-2']) disposeStreakState(id);
});

describe('auto-submit streak survives a tab switch', () => {
  it('keeps counting where it left off after switching away and back', () => {
    bind('streak-tab-1');
    const { result, rerender } = renderHook(() => useAutoSubmitStreak());

    act(() => {
      result.current.recordAutoSubmit();
      result.current.recordAutoSubmit();
    });
    rerender();
    expect(result.current.streak).toBe(2);

    // Switch to the other tab and back.
    bind('streak-tab-2');
    rerender();
    bind('streak-tab-1');
    rerender();

    // The cap is at 3, and two are already spent — one left, not three.
    expect(result.current.streak).toBe(2);
    expect(result.current.canAutoSubmit()).toBe(true);
    act(() => void result.current.recordAutoSubmit());
    expect(result.current.canAutoSubmit()).toBe(false);
  });

  it('does not release a halted loop guard on a tab switch', () => {
    bind('streak-tab-1');
    const { result, rerender } = renderHook(() => useAutoSubmitStreak());

    act(() => {
      expect(result.current.recordPrompt('Run the focused tests')).toBe(true);
      expect(result.current.recordPrompt('run the focused TESTS')).toBe(false);
    });
    expect(result.current.canAutoSubmit()).toBe(false);

    bind('streak-tab-2');
    rerender();
    bind('streak-tab-1');
    rerender();

    // Still halted. Before this, the switch cleared the guard and the same
    // repeated prompt was fed again.
    expect(result.current.canAutoSubmit()).toBe(false);
  });

  it('gives each tab its own counter', () => {
    bind('streak-tab-1');
    const { result, rerender } = renderHook(() => useAutoSubmitStreak());
    act(() => {
      result.current.recordAutoSubmit();
      result.current.recordAutoSubmit();
    });

    bind('streak-tab-2');
    rerender();
    // A different session starts clean — tab 1's spend is not charged to it.
    expect(result.current.streak).toBe(0);
    expect(result.current.canAutoSubmit()).toBe(true);
  });

  it('a halted tab does not halt the other one', () => {
    bind('streak-tab-1');
    const { result, rerender } = renderHook(() => useAutoSubmitStreak());
    act(() => {
      result.current.recordPrompt('Continue');
      result.current.recordPrompt('Continue');
    });
    expect(result.current.canAutoSubmit()).toBe(false);

    bind('streak-tab-2');
    rerender();
    expect(result.current.canAutoSubmit()).toBe(true);
  });

  it('forgets a closed tab’s history', () => {
    bind('streak-tab-1');
    const { result, rerender } = renderHook(() => useAutoSubmitStreak());
    act(() => void result.current.recordAutoSubmit());
    rerender();
    expect(result.current.streak).toBe(1);

    disposeStreakState('streak-tab-1');
    bind('streak-tab-2');
    rerender();
    bind('streak-tab-1');
    rerender();
    expect(result.current.streak).toBe(0);
  });
});
