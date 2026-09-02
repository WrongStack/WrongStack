import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAutoSubmitStreak } from '../../src/stores/auto-submit-streak.js';
import { useLocalPrefs } from '../../src/stores/local-prefs.js';
import { useSessionStore } from '../../src/stores/session-store.js';

/**
 * Verification: when the Autonomy mode is flipped away from 'auto' mid-session,
 * the loop guard must be released so the next entry into 'auto' is a clean
 * start. Without this fix, a halt triggered under 'auto' persists across the
 * mode toggle and the session is permanently stuck on the old guard.
 *
 * The streak lives in module state shared by every hook instance, so each
 * test resets it explicitly first — mirrors the convention in
 * `auto-submit-streak-cap.test.tsx`.
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
  useLocalPrefs.setState({ autonomy: 'auto', autoProceedMaxIterations: 50 });
  session('autonomy-leave-session');

  const { result, unmount } = mount();
  act(() => result.current.reset());
  unmount();
});

describe('autonomy leaves auto — loop guard release', () => {
  it('releases a halted loop guard when autonomy flips auto → off', () => {
    const { result, rerender } = mount();

    // Halt the loop guard with two identical prompts.
    expect(result.current.recordPrompt('Run the focused tests')).toBe(true);
    expect(result.current.recordPrompt('  RUN the focused tests  ')).toBe(false);
    expect(result.current.canAutoSubmit()).toBe(false);

    // Flip autonomy away from 'auto'. The fix MUST release the guard.
    act(() => useLocalPrefs.setState({ autonomy: 'off' }));
    rerender();

    expect(result.current.canAutoSubmit()).toBe(true);
  });

  it('releases a halted loop guard when autonomy flips auto → suggest', () => {
    const { result, rerender } = mount();
    result.current.recordPrompt('repeat me');
    result.current.recordPrompt('repeat me');
    expect(result.current.canAutoSubmit()).toBe(false);

    act(() => useLocalPrefs.setState({ autonomy: 'suggest' }));
    rerender();

    expect(result.current.canAutoSubmit()).toBe(true);
    expect(result.current.recordPrompt('repeat me')).toBe(true);
  });

  it('releases the loop guard and clears the streak when leaving auto', () => {
    const { result, rerender } = mount();
    result.current.recordAutoSubmit();
    result.current.recordAutoSubmit();
    rerender();
    expect(result.current.streak).toBe(2);

    act(() => useLocalPrefs.setState({ autonomy: 'off' }));
    rerender();

    // Leaving auto wipes the streak — the user stepped out of the loop.
    expect(result.current.streak).toBe(0);
    expect(result.current.canAutoSubmit()).toBe(true);
  });

  it('does not clear the loop guard when autonomy stays on auto', () => {
    const { result, rerender } = mount();
    result.current.recordPrompt('repeat me');
    result.current.recordPrompt('repeat me');
    expect(result.current.canAutoSubmit()).toBe(false);

    act(() => useLocalPrefs.setState({ autonomy: 'auto' }));
    rerender();

    // No transition (already auto) → guard stays halted. This guards against
    // the regression where a careless re-entry branch clobbers state.
    expect(result.current.canAutoSubmit()).toBe(false);
  });

  it('full round-trip auto → off → auto ends with a clean guard', () => {
    const { result, rerender } = mount();

    // Halt, leave, return — the session must NOT remain stuck on the old mode.
    result.current.recordPrompt('Run the focused tests');
    result.current.recordPrompt('  RUN the focused tests  ');
    expect(result.current.canAutoSubmit()).toBe(false);

    act(() => useLocalPrefs.setState({ autonomy: 'off' }));
    rerender();
    expect(result.current.canAutoSubmit()).toBe(true);

    act(() => useLocalPrefs.setState({ autonomy: 'auto' }));
    rerender();
    expect(result.current.canAutoSubmit()).toBe(true);

    // The continuation tracker is also reset — a fresh prompt is accepted.
    expect(result.current.recordPrompt('Try a different prompt')).toBe(true);
  });
});
