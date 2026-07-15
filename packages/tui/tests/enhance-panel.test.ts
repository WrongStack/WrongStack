import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EnhancePanel,
  formatRefinementDuration,
  RefiningPanel,
  refinementPulse,
  wrapRefinementPreview,
} from '../src/components/enhance-panel.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('refinement presentation helpers', () => {
  it('formats live and completed durations compactly', () => {
    expect(formatRefinementDuration(420)).toBe('420ms');
    expect(formatRefinementDuration(2_840)).toBe('2.8s');
    expect(formatRefinementDuration(72_000)).toBe('1m 12s');
  });

  it('builds a fixed-width scanning pulse without implying progress', () => {
    expect(refinementPulse(0, 6)).toBe('●·····');
    expect(refinementPulse(3, 6)).toBe('···●··');
    expect(refinementPulse(7, 6)).toBe('···●··');
    expect(refinementPulse(3, 0)).toBe('');
  });

  it('normalizes and bounds long prompt previews', () => {
    expect(wrapRefinementPreview('  fix   the\nlogin flow safely ', 12, 2)).toEqual([
      'fix the',
      'login flow…',
    ]);
    expect(wrapRefinementPreview('short prompt', 20, 2)).toEqual(['short prompt']);
  });
});

describe('RefiningPanel', () => {
  it('shows a real elapsed timer, activity contract, request, and escape path', () => {
    const view = render(
      React.createElement(RefiningPanel, {
        original: 'Refactor the authentication middleware without changing public behavior',
        elapsedMs: 3_450,
        pulseFrame: 4,
      }),
    );
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('PROMPT REFINER');
    expect(frame).toContain('REFINING');
    expect(frame).toContain('WORKING');
    expect(frame).toContain('3.5s');
    expect(frame).toContain('clarifying intent · preserving constraints · preparing variants');
    expect(frame).toContain('REQUEST');
    expect(frame).toContain('authentication middleware');
    expect(frame).toContain('Esc cancels and returns to edit');

    view.unmount();
  });
});

describe('EnhancePanel', () => {
  const props = () => ({
    original: 'fix auth',
    refined: 'Fix the authentication failure and preserve existing API behavior.',
    english: 'Fix the authentication failure while keeping the public API unchanged.',
    durationMs: 2_840,
    delayMs: 60_000,
    onDecision: vi.fn(),
    onTick: vi.fn(),
  });

  it('renders a responsive before/after comparison and completion metadata', () => {
    const input = props();
    const view = render(React.createElement(EnhancePanel, input));
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('REFINEMENT READY');
    expect(frame).toContain('ready in 2.8s');
    expect(frame).toContain('AUTO-SEND ARMED');
    expect(frame).toContain('BEFORE');
    expect(frame).toContain('RECOMMENDED');
    expect(frame).toContain('ENGLISH OPTION');
    expect(frame).toContain('Fix the authentication failure');
    expect(frame).toContain('Enter');
    expect(frame).toContain('use refined');
    expect(frame).toContain('status-bar timer ends');
    expect(input.onTick).toHaveBeenCalledWith(60);

    view.unmount();
  });

  it('keeps the existing keyboard decisions', () => {
    const input = props();
    const view = render(React.createElement(EnhancePanel, input));

    view.stdin.write('e');
    expect(input.onDecision).toHaveBeenCalledWith('english');

    view.unmount();
  });

  it('auto-selects the recommended version when the countdown expires', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const onTick = vi.fn();
    const view = render(
      React.createElement(EnhancePanel, {
        ...props(),
        delayMs: 2_000,
        onDecision,
        onTick,
      }),
    );

    expect(onTick).toHaveBeenCalledWith(2);
    act(() => vi.advanceTimersByTime(2_000));
    expect(onTick).toHaveBeenLastCalledWith(0);
    expect(onDecision).toHaveBeenCalledWith('refined');

    view.unmount();
  });
});
