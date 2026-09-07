import { render } from 'ink-testing-library';
import React, { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BugHuntRunningPanel } from '../src/components/bug-hunt-running-panel.js';
import { BugHuntContinuePanel } from '../src/components/bug-hunt-continue-panel.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('BugHuntRunningPanel', () => {
  it('renders round label with total rounds', () => {
    const view = render(
      React.createElement(BugHuntRunningPanel, {
        currentRound: 2,
        totalRounds: 5,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('BUG HUNTING STARTED');
    expect(frame).toContain('Round 2/5');
    expect(frame).toContain('proof-driven scan, reproduce, fix, verify');
    view.unmount();
  });

  it('renders round label without total rounds', () => {
    const view = render(
      React.createElement(BugHuntRunningPanel, {
        currentRound: 3,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Round 3');
    view.unmount();
  });
});

describe('BugHuntContinuePanel', () => {
  it('renders panel with total rounds and controls hint', () => {
    const view = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 2,
        totalRounds: 4,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Proof-Driven Bug Hunter — Round 2/4 completed');
    expect(frame).toContain('Continue with the next proof-driven round?');
    expect(frame).toContain('Automatically continuing in 30s.');
    expect(frame).toContain('[Enter/Y]');
    expect(frame).toContain('[Esc/S/N]');
    view.unmount();
  });

  it('renders panel without total rounds', () => {
    const view = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Proof-Driven Bug Hunter — Round 1 completed');
    view.unmount();
  });

  it('automatically continues when timer expires', () => {
    vi.useFakeTimers();
    const onDecision = vi.fn();
    const view = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision,
      }),
    );

    expect(view.lastFrame() ?? '').toContain('Automatically continuing in 30s.');
    act(() => vi.advanceTimersByTime(10_000));
    expect(view.lastFrame() ?? '').toContain('Automatically continuing in 20s.');

    act(() => vi.advanceTimersByTime(20_000));
    expect(onDecision).toHaveBeenCalledWith('yes');
    view.unmount();
  });

  it('decides yes on Enter keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision,
      }),
    );
    stdin.write('\r');
    expect(onDecision).toHaveBeenCalledWith('yes');
    unmount();
  });

  it('decides yes on "y" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision,
      }),
    );
    stdin.write('y');
    expect(onDecision).toHaveBeenCalledWith('yes');
    unmount();
  });

  it('decides stop on "s" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision,
      }),
    );
    stdin.write('s');
    expect(onDecision).toHaveBeenCalledWith('stop');
    unmount();
  });

  it('decides stop on "n" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision,
      }),
    );
    stdin.write('n');
    expect(onDecision).toHaveBeenCalledWith('stop');
    unmount();
  });

  it('only fires decision once even with multiple keypresses', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BugHuntContinuePanel, {
        completedRounds: 1,
        onDecision,
      }),
    );
    stdin.write('y');
    stdin.write('s');
    stdin.write('n');
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith('yes');
    unmount();
  });
});
