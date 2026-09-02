import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PhasePanel } from '../src/components/phase-panel.js';

describe('PhasePanel', () => {
  it('renders nothing visible when no phases', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {},
        nowTick: 0,
      } as never),
    );
    // Component returns null, but ink-testing-library wraps it so lastFrame() is ''
    expect(view.lastFrame() ?? '').toBe('');
    view.unmount();
  });

  it('renders header with counts', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: { name: 'Research', status: 'completed', completedTasks: 3, totalTasks: 3 },
        },
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Phases');
    expect(frame).toContain('✓1');
    view.unmount();
  });

  it('shows running count with play icon', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: {
            name: 'Build',
            status: 'running',
            completedTasks: 1,
            totalTasks: 5,
            startedAt: 100,
          },
        },
        nowTick: 1000,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('▶1');
    view.unmount();
  });

  it('shows failed count when phases failed', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: { name: 'Deploy', status: 'failed', completedTasks: 0, totalTasks: 5 },
        },
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✗1');
    view.unmount();
  });

  it('does not show failed count when none failed', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: { name: 'Done', status: 'completed', completedTasks: 5, totalTasks: 5 },
        },
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('✗');
    view.unmount();
  });

  it('shows total count', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: { name: 'A', status: 'pending', completedTasks: 0, totalTasks: 0 },
          p2: { name: 'B', status: 'completed', completedTasks: 1, totalTasks: 1 },
        },
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('2 total');
    view.unmount();
  });

  it('shows progress for running phases', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: {
            name: 'Coding',
            status: 'running',
            completedTasks: 2,
            totalTasks: 10,
            startedAt: 500,
          },
        },
        nowTick: 2000,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('2/10');
    view.unmount();
  });

  it('shows elapsed time for running phases', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: {
            name: 'Testing',
            status: 'running',
            completedTasks: 1,
            totalTasks: 8,
            startedAt: 1000,
          },
        },
        nowTick: 4000,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('3s');
    view.unmount();
  });

  it('renders all phase status types', () => {
    const statuses = ['pending', 'ready', 'running', 'paused', 'completed', 'failed', 'skipped'];
    const phases: Record<
      string,
      { name: string; status: string; completedTasks: number; totalTasks: number }
    > = {};
    for (const s of statuses) {
      phases[s] = { name: `Phase-${s}`, status: s, completedTasks: 0, totalTasks: 0 };
    }
    const view = render(
      React.createElement(PhasePanel, {
        phases,
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    // Running phase renders each character individually with rainbow colors,
    // so "Phase-running" appears as "P h a s e - r u n n i n g"
    expect(frame).toContain('Phase-pending');
    expect(frame).toContain('Phase-ready');
    expect(frame).toContain('Phase-paused');
    expect(frame).toContain('Phase-complete');
    expect(frame).toContain('Phase-failed');
    expect(frame).toContain('Phase-skipped');
    // For running phase, each char is rendered individually with rainbow colors
    expect(frame).toContain('P h a s e - r u n n i n g');
    view.unmount();
  });

  it('renders unknown status with fallback icon', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: { name: 'Custom', status: 'weird-status', completedTasks: 0, totalTasks: 0 },
        },
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Custom');
    view.unmount();
  });

  it('shows Ctrl+P hint in header', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: { name: 'A', status: 'pending', completedTasks: 0, totalTasks: 0 },
        },
        nowTick: 0,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Ctrl+P');
    view.unmount();
  });

  it('renders running phase with rainbow-colored chars', () => {
    const view = render(
      React.createElement(PhasePanel, {
        phases: {
          p1: {
            name: 'Active',
            status: 'running',
            completedTasks: 0,
            totalTasks: 5,
            startedAt: 100,
          },
        },
        nowTick: 500,
      } as never),
    );
    const frame = view.lastFrame() ?? '';
    // Running phase renders each character individually with rainbow colors,
    // so "Active" appears as "A c t i v e" with spaces between chars
    expect(frame).toContain('A c t i v e');
    view.unmount();
  });
});
