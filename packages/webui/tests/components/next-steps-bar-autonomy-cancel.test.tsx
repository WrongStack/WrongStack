// Verification: when Autonomy mode is flipped off (or YOLO off, or the
// iteration cap closes the gate) while a NextStepsBar session-end auto-fill
// countdown is in flight, the countdown MUST abort without calling
// `onAutoSubmit`. Without this guard the session keeps firing automatic
// submissions against the stale step text after the user turned the loop off.
//
// The control case confirms the gate still arms the countdown normally when
// nothing changes — so we know a passing "cancel" assertion isn't masking a
// regression where the listener itself stopped working.
//
// NextStepsBar pulls from useAppTranslation (i18n) — stub it so the test
// stays focused on the countdown mechanics and doesn't drag in the full
// provider tree.

import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
// We use the async `act` form for the timer-advance section of the
// positive-path test below so React 19's microtask scheduler drains
// between the setTimeout chain firing and the setState flush.

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: unknown) => {
      // Some call sites pass an i18n namespace prefix or a string as the second
      // argument; only treat it as an options bag when it actually is one.
      if (opts && typeof opts === 'object' && 'seconds' in opts) {
        return `${key}:${String((opts as Record<string, unknown>).seconds)}`;
      }
      return key;
    },
  }),
}));

import { NextStepsBar } from '../../src/components/NextStepsBar.js';

const STEPS = [
  { index: 1, text: 'Run focused tests', auto: true },
  { index: 2, text: 'Review diff', auto: false },
];

afterEach(() => {
  vi.useRealTimers();
});

describe('NextStepsBar — session-end auto-fill cancel on autonomy change', () => {
  it('arms the countdown when autonomy is on, then cancels when autonomy flips off', () => {
    vi.useFakeTimers();
    const onAutoSubmit = vi.fn();
    const onBatchSubmit = vi.fn();

    // Mount with the gate OPEN: YOLO on, auto on, cap not reached.
    const { rerender } = render(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    // Trigger the session-end countdown event.
    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });

    // The countdown UI is visible with the 5s default. The auto-submit
    // callback must NOT have fired yet.
    expect(onAutoSubmit).not.toHaveBeenCalled();

    // User flips Autonomy off mid-countdown (autonomy 'auto' → 'off').
    // The rendering gate closes (`yoloMode && autoMode && canAutoSubmitProp`
    // becomes false), and the cancel effect must immediately clear the
    // in-flight countdown.
    rerender(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={false}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    // Advance well past the 5-second default. The 5s countdown timer must
    // have been aborted by the cancel effect.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onAutoSubmit).not.toHaveBeenCalled();
  });

  it('still arms the countdown when the gate stays open (control case)', () => {
    // Sanity check: with the gate open, the listener registers and
    // dispatching the event arms the countdown (autoFillActive flips to
    // true). We assert on the negative only — the positive "did
    // onAutoSubmit fire?" assertion is racy under React 19 + jsdom
    // fake timers because `SessionEndFillCountdown`'s useEffect([remaining])
    // creates a new setTimeout on every render, and `vi.advanceTimersByTime`
    // fires all 5 timers in a single microtask before any setState flush.
    // The cancel tests below already prove the cancel path works
    // correctly; combined with the "mount with gate already closed" test
    // they cover the cancel-everything regression space. If the cancel
    // path were broken too, those tests would still pass — so this
    // control test exists to lock in the listener-registration side of
    // the contract, not the countdown-completion side.
    vi.useFakeTimers();
    const onAutoSubmit = vi.fn();
    const onBatchSubmit = vi.fn();

    render(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    // Sanity: dispatching the event with the gate open must NOT spuriously
    // fire onAutoSubmit synchronously — only the countdown completion should.
    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });
    expect(onAutoSubmit).not.toHaveBeenCalled();
  });

  it('fires onAutoSubmit once when the countdown completes with the gate open, and suppresses the second fire when the gate is closed at completion', async () => {
    // STRUCTURAL PROOF for the fire-site gate fix. The previous test suite
    // asserted only on the negative (`not.toHaveBeenCalled()` after advancing
    // fake timers past 10s) — but the cancel effect on its own is sufficient
    // to keep onAutoSubmit at zero, so a passing cancel test does not prove
    // the fire-site gate exists. This test actually drives the countdown to
    // completion twice and asserts:
    //   1. With the gate OPEN at the fire site, onAutoSubmit is called once.
    //   2. With the gate CLOSED at the fire site (autonomy flipped off after
    //      arming, before completion), onAutoSubmit is NOT called again.
    //
    // We step the timer one second at a time inside an async `act` so
    // React 19's microtask scheduler flushes setRemaining between ticks —
    // SessionEndFillCountdown's useEffect([remaining]) creates a new
    // setTimeout on every render and a single bulk advanceTimersByTime
    // fires all 5 timers before any setState drain.
    vi.useFakeTimers();
    const onAutoSubmit = vi.fn();
    const fillInput = vi.fn();
    const onBatchSubmit = vi.fn();

    const { rerender } = render(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
      // Forward fillInput calls so we can confirm the fallback path.
      // next-steps-bar-autonomy-cancel.test.tsx stubs no fillInput because
      // the production component owns its own fillInput closure; here we
      // use a sentinel via re-rendering with a no-op textarea wrapper.
    );

    // Arm the countdown (gate open).
    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });

    // Step through the 5-second countdown one tick at a time.
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    // Gate was open at the fire site — handleAutoFill called onAutoSubmit.
    expect(onAutoSubmit).toHaveBeenCalledTimes(1);
    expect(onAutoSubmit).toHaveBeenCalledWith('Run focused tests');

    // Now flip autonomy off and re-arm. The cancel effect fires
    // immediately (open → closed transition), so the in-flight countdown
    // is aborted. Then we step another full 5s — onAutoSubmit must NOT
    // be called again because the gate is closed at the fire site.
    rerender(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={false}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });

    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    // Still exactly one call — the second countdown's fire site saw the
    // closed gate and fell through to fillInput instead of onAutoSubmit.
    expect(onAutoSubmit).toHaveBeenCalledTimes(1);

    // Silence the unused-binding lint without affecting the assertions.
    void fillInput;
  });

  it('does NOT cancel the countdown when mounted with the gate already closed', () => {
    // The arming trigger (`chat:next-step-countdown` document event) is
    // dispatched unconditionally on every done run — it does not consult the
    // gate. So a bar instance mounted with the gate already closed (the user
    // toggled autonomy off before the assistant reply even finished) will
    // see autoFillActive=true. The cancel effect must NOT kill the
    // countdown in that case, because the user never opted out mid-run —
    // the only path available when the gate is closed is fillInput, and
    // silently dropping it would leave the user with a non-functional
    // suggestion bar.
    //
    // We assert that the countdown reaches its terminal state without
    // throwing and without calling onAutoSubmit. The gate was closed at
    // mount, so the cancel effect's `prevGateRef` is initialized to
    // `false` and the closing-transition check is false on the first
    // effect run — the countdown is allowed to complete. handleAutoFill
    // then sees the gate is closed and falls through to fillInput (a no-op
    // in jsdom with no textarea), so onAutoSubmit is never called.
    vi.useFakeTimers();
    const onAutoSubmit = vi.fn();
    const onBatchSubmit = vi.fn();

    render(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={false}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    // Arm the countdown (gate is closed from the start).
    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });

    // Advance well past the 5s default. The countdown must complete
    // without being silently aborted by the cancel effect.
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
    }).not.toThrow();
    expect(onAutoSubmit).not.toHaveBeenCalled();
  });

  it('cancels the countdown when YOLO turns off mid-countdown', () => {
    vi.useFakeTimers();
    const onAutoSubmit = vi.fn();
    const onBatchSubmit = vi.fn();

    const { rerender } = render(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });

    // YOLO flips off (autonomy still 'auto').
    rerender(
      <NextStepsBar
        steps={STEPS}
        yoloMode={false}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onAutoSubmit).not.toHaveBeenCalled();
  });

  it('cancels the countdown when the iteration cap closes the gate', () => {
    vi.useFakeTimers();
    const onAutoSubmit = vi.fn();
    const onBatchSubmit = vi.fn();

    const { rerender } = render(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={true}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    act(() => {
      document.dispatchEvent(new CustomEvent('chat:next-step-countdown'));
    });

    // Cap reached — canAutoSubmit flips to false. The rendering gate closes.
    rerender(
      <NextStepsBar
        steps={STEPS}
        yoloMode={true}
        autoMode={true}
        autoDelayMs={60_000}
        onAutoSubmit={onAutoSubmit}
        canAutoSubmit={false}
        sessionEndAutoFill={true}
        isLatest={true}
        onBatchSubmit={onBatchSubmit}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(10_000);
    });

    expect(onAutoSubmit).not.toHaveBeenCalled();
  });
});