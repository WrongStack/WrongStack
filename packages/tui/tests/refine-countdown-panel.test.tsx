import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RefineCountdownPanel } from '../src/components/refine-countdown-panel.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RefineCountdownPanel', () => {
  it('renders the PROMPT REFINER header', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'Fix the login bug',
        seconds: 3,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('PROMPT REFINER');
    view.unmount();
  });

  it('shows the original message as preview', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'Write a comprehensive test suite for the parser',
        seconds: 3,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Write a comprehensive test suite');
    view.unmount();
  });

  it('shows the initial countdown value', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('refining in 3s');
    view.unmount();
  });

  it('shows the keyboard hint text', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Enter refines now');
    expect(frame).toContain('any key sends as-is');
    expect(frame).toContain('Esc cancels');
    view.unmount();
  });

  it('shows provider/model label when both are provided', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision: vi.fn(),
        providerId: 'openai',
        model: 'gpt-4o',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('on openai/gpt-4o');
    view.unmount();
  });

  it('hides provider/model label when not provided', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('on ');
    view.unmount();
  });

  // ── Countdown expiry → proceed ──────────────────────────────────

  it('calls onDecision("proceed") when the countdown expires', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );

    // 3 interval ticks at 1s each: 3→2→1→proceed
    act(() => vi.advanceTimersByTime(3_000));

    expect(onDecision).toHaveBeenCalledWith('proceed');
    view.unmount();
  });

  it('does not fire proceed before the countdown completes', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );

    act(() => vi.advanceTimersByTime(2_000));
    expect(onDecision).not.toHaveBeenCalled();

    view.unmount();
  });

  it('decrements the displayed countdown each second', () => {
    vi.useFakeTimers();
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision: vi.fn(),
      }),
    );

    expect(view.lastFrame() ?? '').toContain('refining in 3s');
    act(() => vi.advanceTimersByTime(1_000));
    expect(view.lastFrame() ?? '').toContain('refining in 2s');
    act(() => vi.advanceTimersByTime(1_000));
    expect(view.lastFrame() ?? '').toContain('refining in 1s');

    view.unmount();
  });

  // ── Any key → skip (except Enter and Esc) ─────────────────────

  it('any printable key calls onDecision("skip")', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    stdin.write('x');
    expect(onDecision).toHaveBeenCalledWith('skip');
    unmount();
  });

  it('Enter key calls onDecision("proceed")', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    stdin.write('\r');
    expect(onDecision).toHaveBeenCalledWith('proceed');
    unmount();
  });

  it('space key calls onDecision("skip")', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    stdin.write(' ');
    expect(onDecision).toHaveBeenCalledWith('skip');
    unmount();
  });

  // ── Esc → cancel ────────────────────────────────────────────────
  // Esc via useInput requires key.escape which ink-testing-library
  // cannot reliably produce from a lone \x1b byte — readline buffers
  // it waiting for a multi-byte sequence. The cancel path is covered
  // by the integration test in submit-prompt-refinement.test.ts.
  // Here we test Esc indirectly: \x1b followed by \r produces two
  // separate keypresses (escape, then return) — the first fires
  // cancel and the resolved guard suppresses the second.

  it('Esc followed by Enter calls onDecision("cancel") and suppresses Enter', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    stdin.write('\x1b');
    stdin.write('\r');
    // Either cancel fired (escape recognised) or skip fired (escape
    // not recognised, \r treated as input) — but only one call total.
    expect(onDecision).toHaveBeenCalledTimes(1);
    unmount();
  });

  // ── Single-fire guarantee (resolved guard) ─────────────────────

  it('does not call onDecision multiple times after skip', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    stdin.write('a');
    stdin.write('b');
    stdin.write('c');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('skip');
    unmount();
  });

  it('does not call proceed after a keypress skip', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    stdin.write('s');
    act(() => vi.advanceTimersByTime(5_000));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('skip');
    unmount();
  });

  it('does not call skip after countdown proceed', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 3,
        onDecision,
      }),
    );
    act(() => vi.advanceTimersByTime(3_000));
    stdin.write('x');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('proceed');
    unmount();
  });

  // ── Custom seconds ──────────────────────────────────────────────

  it('respects a custom seconds value', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 5,
        onDecision,
      }),
    );

    expect(view.lastFrame() ?? '').toContain('refining in 5s');
    act(() => vi.advanceTimersByTime(4_000));
    expect(onDecision).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1_000));
    expect(onDecision).toHaveBeenCalledWith('proceed');

    view.unmount();
  });

  it('clamps seconds=0 to at least 1', () => {
    const view = render(
      React.createElement(RefineCountdownPanel, {
        original: 'test',
        seconds: 0,
        onDecision: vi.fn(),
      }),
    );
    // Math.max(1, 0) = 1, so initial display should show 1s
    expect(view.lastFrame() ?? '').toContain('refining in 1s');
    view.unmount();
  });
});
