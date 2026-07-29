import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAutoSubmitStreak } from '../../src/stores/auto-submit-streak.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionStore } from '../../src/stores/session-store.js';

/**
 * The iteration cap and the two reset triggers (a new backend session, and
 * autonomy switching to 'auto'). The streak lives in module state shared by
 * every hook instance, so each test resets it explicitly first.
 */

function session(id: string) {
  useSessionStore.getState().setSession({
    id,
    startedAt: Date.now(),
    provider: 'test',
    model: 'test',
  });
}

function mount() {
  return renderHook(() => useAutoSubmitStreak());
}

beforeEach(() => {
  useLocalPrefs.setState({ autonomy: 'auto', autoProceedMaxIterations: 3 });
  session('cap-session');

  const { result, unmount } = mount();
  act(() => result.current.reset());
  unmount();
});

describe('iteration cap', () => {
  it('allows submissions up to the cap and then stops', () => {
    const { result, rerender } = mount();

    expect(result.current.canAutoSubmit()).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      expect(result.current.recordAutoSubmit()).toBe(true);
    }

    expect(result.current.canAutoSubmit()).toBe(false);
    rerender();
    expect(result.current.streak).toBe(3);
  });

  it('refuses to record past the cap', () => {
    const { result } = mount();
    for (let i = 0; i < 3; i += 1) result.current.recordAutoSubmit();
    expect(result.current.recordAutoSubmit()).toBe(false);
  });

  it('raises the cap warning on the submission that reaches the cap', () => {
    const { result, rerender } = mount();

    result.current.recordAutoSubmit();
    rerender();
    expect(result.current.capWarned).toBe(false);

    result.current.recordAutoSubmit();
    result.current.recordAutoSubmit();
    rerender();
    expect(result.current.capWarned).toBe(true);
  });

  it('treats a cap of zero as unlimited', () => {
    useLocalPrefs.setState({ autoProceedMaxIterations: 0 });
    const { result, rerender } = mount();

    for (let i = 0; i < 20; i += 1) expect(result.current.recordAutoSubmit()).toBe(true);
    rerender();

    expect(result.current.canAutoSubmit()).toBe(true);
    expect(result.current.capWarned).toBe(false);
  });

  it('treats a negative cap as unlimited too', () => {
    useLocalPrefs.setState({ autoProceedMaxIterations: -1 });
    const { result } = mount();
    expect(result.current.canAutoSubmit()).toBe(true);
  });

  it('resetCapWarned clears the warning without touching the streak', () => {
    const { result, rerender } = mount();
    for (let i = 0; i < 3; i += 1) result.current.recordAutoSubmit();
    rerender();
    expect(result.current.capWarned).toBe(true);

    act(() => result.current.resetCapWarned());
    rerender();

    expect(result.current.capWarned).toBe(false);
    expect(result.current.streak).toBe(3);
    // The cap itself still applies — only the warning was dismissed.
    expect(result.current.canAutoSubmit()).toBe(false);
  });

  it('a halted loop blocks auto-submission regardless of the streak', () => {
    const { result } = mount();
    result.current.recordPrompt('same prompt');
    result.current.recordPrompt('same prompt');

    expect(result.current.canAutoSubmit()).toBe(false);
  });
});

describe('session boundary', () => {
  it('starts a fresh streak when the backend session changes', () => {
    const { result, rerender } = mount();
    for (let i = 0; i < 3; i += 1) result.current.recordAutoSubmit();
    rerender();
    expect(result.current.streak).toBe(3);

    act(() => session('a-different-session'));
    rerender();

    expect(result.current.streak).toBe(0);
    expect(result.current.capWarned).toBe(false);
    expect(result.current.canAutoSubmit()).toBe(true);
  });

  it('clears a halted loop guard across the boundary', () => {
    const { result, rerender } = mount();
    result.current.recordPrompt('repeat me');
    result.current.recordPrompt('repeat me');
    expect(result.current.canAutoSubmit()).toBe(false);

    act(() => session('yet-another-session'));
    rerender();

    expect(result.current.canAutoSubmit()).toBe(true);
    expect(result.current.recordPrompt('repeat me')).toBe(true);
  });

  it('leaves the streak alone when the session id is unchanged', () => {
    const { result, rerender } = mount();
    result.current.recordAutoSubmit();
    rerender();

    act(() => session('cap-session'));
    rerender();

    expect(result.current.streak).toBe(1);
  });
});

describe('autonomy switch', () => {
  it('clears the cap warning when autonomy turns on, keeping the streak', () => {
    useLocalPrefs.setState({ autonomy: 'off' });
    const { result, rerender } = mount();

    for (let i = 0; i < 3; i += 1) result.current.recordAutoSubmit();
    rerender();
    expect(result.current.capWarned).toBe(true);

    act(() => useLocalPrefs.setState({ autonomy: 'auto' }));
    rerender();

    // A mode switch is a setting change, not a manual turn — the streak
    // survives, only the warning window resets.
    expect(result.current.capWarned).toBe(false);
    expect(result.current.streak).toBe(3);
  });

  it('does nothing when autonomy switches away from auto', () => {
    const { result, rerender } = mount();
    for (let i = 0; i < 3; i += 1) result.current.recordAutoSubmit();
    rerender();

    act(() => useLocalPrefs.setState({ autonomy: 'off' }));
    rerender();

    expect(result.current.capWarned).toBe(true);
  });

  it('does nothing when autonomy is already auto', () => {
    const { result, rerender } = mount();
    for (let i = 0; i < 3; i += 1) result.current.recordAutoSubmit();
    rerender();

    act(() => useLocalPrefs.setState({ autonomy: 'auto' }));
    rerender();

    expect(result.current.capWarned).toBe(true);
  });
});
