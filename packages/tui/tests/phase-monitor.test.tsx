import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PhaseMonitor } from '../src/components/phase-monitor.js';

describe('PhaseMonitor', () => {
  it('renders the header', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('PHASE MONITOR');
    expect(frame).toContain('▶0');
    expect(frame).toContain('✓0');
    expect(frame).toContain('Ctrl+P to close');
    view.unmount();
  });

  it('shows empty state when no phases', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No phases active');
    view.unmount();
  });

  it('renders phases with status icons', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {
          p1: {
            name: 'Research',
            status: 'running',
            completedTasks: 1,
            totalTasks: 5,
            startedAt: 1000,
            activeTasks: [],
          },
          p2: { name: 'Write', status: 'completed', completedTasks: 3, totalTasks: 3 },
        },
        runningPhaseIds: ['p1'],
        elapsedMs: 5000,
        nowTick: 6000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Research');
    expect(frame).toContain('Write');
    expect(frame).toContain('▶1');
    expect(frame).toContain('✓1');
    view.unmount();
  });

  it('shows failed count when phases failed', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {
          p1: { name: 'Deploy', status: 'failed', completedTasks: 2, totalTasks: 8 },
        },
        runningPhaseIds: [],
        elapsedMs: 1000,
        nowTick: 2000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✗1');
    view.unmount();
  });

  it('renders phase with all status types', () => {
    const statuses = ['pending', 'ready', 'running', 'paused', 'completed', 'failed', 'skipped'];
    const phases: Record<
      string,
      { name: string; status: string; completedTasks: number; totalTasks: number }
    > = {};
    for (const s of statuses) {
      phases[s] = { name: `Phase-${s}`, status: s, completedTasks: 0, totalTasks: 0 };
    }
    const view = render(
      React.createElement(PhaseMonitor, {
        phases,
        runningPhaseIds: ['running'],
        elapsedMs: 0,
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    for (const s of statuses) {
      expect(frame).toContain(`Phase-${s}`);
    }
    view.unmount();
  });

  it('renders unknown status with fallback icon', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {
          p1: { name: 'Custom', status: 'custom-status', completedTasks: 0, totalTasks: 0 },
        },
        runningPhaseIds: [],
        elapsedMs: 0,
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Custom');
    view.unmount();
  });

  it('shows active tasks for running phase', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {
          p1: {
            name: 'Build',
            status: 'running',
            completedTasks: 2,
            totalTasks: 10,
            startedAt: 100,
            activeTasks: [{ taskId: 't1', title: 'Compile', agent: 'builder' }],
          },
        },
        runningPhaseIds: ['p1'],
        elapsedMs: 5000,
        nowTick: 6000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Compile');
    expect(frame).toContain('builder');
    view.unmount();
  });

  it('shows elapsed time for running phase', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {
          p1: {
            name: 'Test',
            status: 'running',
            completedTasks: 0,
            totalTasks: 5,
            startedAt: 1000,
            activeTasks: [],
          },
        },
        runningPhaseIds: ['p1'],
        elapsedMs: 5000,
        nowTick: 7000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('elapsed');
    view.unmount();
  });

  it('shows task progress when totalTasks > 0', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {
          p1: {
            name: 'Code',
            status: 'running',
            completedTasks: 3,
            totalTasks: 10,
            startedAt: 100,
            activeTasks: [],
          },
        },
        runningPhaseIds: ['p1'],
        elapsedMs: 0,
        nowTick: 500,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('3/10');
    view.unmount();
  });

  it('shows keyboard hint at bottom', () => {
    const view = render(
      React.createElement(PhaseMonitor, {
        phases: {},
        runningPhaseIds: [],
        elapsedMs: 0,
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('↑/↓ navigate phases');
    view.unmount();
  });
});
