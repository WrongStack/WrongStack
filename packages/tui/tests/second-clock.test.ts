import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Text } from '../src/ink.js';
import { useElapsedMs, useSecondTick } from '../src/second-clock.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function TickHarness({ label, active = true }: { label: string; active?: boolean }) {
  const tick = useSecondTick(active);
  return React.createElement(Text, null, `${label}=${tick}`);
}

function lastValue(view: ReturnType<typeof render>, label: string): number {
  const frame = view.lastFrame() ?? '';
  const match = new RegExp(`${label}=(\\d+)`).exec(frame);
  return match ? Number(match[1]) : Number.NaN;
}

describe('shared 1s subscriber clock', () => {
  it('serves every active subscriber from ONE interval and batches the tick', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(TickHarness, { label: 'a' }),
          React.createElement(TickHarness, { label: 'b' }),
        ),
      );
    });
    // Two active subscribers, one shared interval — not one interval each.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const a0 = lastValue(view, 'a');
    const b0 = lastValue(view, 'b');

    act(() => vi.advanceTimersByTime(1_000));
    expect(lastValue(view, 'a')).toBe(a0 + 1);
    expect(lastValue(view, 'b')).toBe(b0 + 1);

    act(() => vi.advanceTimersByTime(2_000));
    expect(lastValue(view, 'a')).toBe(a0 + 3);
    expect(lastValue(view, 'b')).toBe(b0 + 3);
    act(() => view.unmount());
  });

  it('stops the interval when the last subscriber unmounts', () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(React.createElement(TickHarness, { label: 'solo' }));
    });
    act(() => view.unmount());
    expect(clearIntervalSpy).toHaveBeenCalled();

    // A later subscriber starts a fresh interval and keeps counting.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let view2!: ReturnType<typeof render>;
    act(() => {
      view2 = render(React.createElement(TickHarness, { label: 'again' }));
    });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    const before = lastValue(view2, 'again');
    act(() => vi.advanceTimersByTime(1_000));
    expect(lastValue(view2, 'again')).toBe(before + 1);
    act(() => view2.unmount());
  });

  it('inactive subscribers never start the interval and never tick', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(React.createElement(TickHarness, { label: 'idle', active: false }));
    });
    expect(setIntervalSpy).not.toHaveBeenCalled();
    const before = lastValue(view, 'idle');
    act(() => vi.advanceTimersByTime(5_000));
    expect(lastValue(view, 'idle')).toBe(before);
    act(() => view.unmount());
  });
});

describe('useElapsedMs', () => {
  function ElapsedHarness({ base, startedAt }: { base: number; startedAt: number | null }) {
    const ms = useElapsedMs(base, startedAt);
    return React.createElement(Text, null, `ms=${ms}`);
  }

  it('accumulates the live spell on the shared tick and freezes when idle', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T00:00:10.000Z'));
    let view!: ReturnType<typeof render>;
    act(() => {
      view = render(
        React.createElement(ElapsedHarness, { base: 5_000, startedAt: Date.now() - 2_000 }),
      );
    });
    expect(view.lastFrame()?.trim()).toBe('ms=7000');

    act(() => vi.advanceTimersByTime(1_000));
    expect(view.lastFrame()?.trim()).toBe('ms=8000');

    // Spell ends: the base absorbs the delta and the leaf unsubscribes.
    act(() => {
      view.rerender(React.createElement(ElapsedHarness, { base: 9_000, startedAt: null }));
    });
    expect(view.lastFrame()?.trim()).toBe('ms=9000');
    act(() => vi.advanceTimersByTime(3_000));
    expect(view.lastFrame()?.trim()).toBe('ms=9000');
    act(() => view.unmount());
  });
});
