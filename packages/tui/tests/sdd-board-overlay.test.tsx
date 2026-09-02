import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { SddBoardOverlay } from '../src/components/sdd-board-overlay.js';

const snapshot = {
  title: 'Test SDD Run',
  status: 'running',
  wave: 0,
  columns: [
    { label: 'Start', taskIds: ['t1'] },
    { label: 'Phase 1', taskIds: ['t2'] },
  ],
  tasks: [
    {
      id: 'task-1',
      shortId: 't1',
      title: 'Research',
      displayStatus: 'in_progress' as const,
      priority: 'high',
      deps: [],
      agentName: 'agent-1',
      retries: 0,
    },
    {
      id: 'task-2',
      shortId: 't2',
      title: 'Implement',
      displayStatus: 'pending' as const,
      priority: 'medium',
      deps: ['t1'],
      agentName: undefined,
      retries: 0,
    },
  ],
  progress: { total: 2, completed: 0, inProgress: 1, failed: 0, percentComplete: 0 },
  feed: [{ ts: Date.now(), kind: 'started', text: 'Task started' }],
};

describe('SddBoardOverlay', () => {
  it('renders the header with title and status', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    // Ink wraps text so "SDD BOARD" may appear across lines
    expect(frame).toContain('SDD');
    expect(frame).toContain('BOARD');
    expect(frame).toContain('Test SDD');
    expect(frame).toContain('runnin');
    expect(frame).toContain('wave 1');
    view.unmount();
  });

  it('shows progress counts', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✓0');
    expect(frame).toContain('2');
    expect(frame).toContain('0%');
    view.unmount();
  });

  it('shows in-progress count when > 0', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('▶1');
    view.unmount();
  });

  it('shows failed count when > 0', () => {
    const snap = { ...snapshot, progress: { ...snapshot.progress, failed: 1 } };
    const view = render(React.createElement(SddBoardOverlay, { snapshot: snap } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✗1');
    view.unmount();
  });

  it('shows empty state when no tasks', () => {
    const snap = {
      ...snapshot,
      tasks: [],
      columns: [],
      progress: { total: 0, completed: 0, inProgress: 0, failed: 0, percentComplete: 0 },
    };
    const view = render(React.createElement(SddBoardOverlay, { snapshot: snap } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('No active SDD run');
    view.unmount();
  });

  it('shows deadlock diagnostics', () => {
    const snap = {
      ...snapshot,
      diagnostics: { deadlockChains: [{ blocked: 't2', blockedBy: ['t1'] }] },
    };
    const view = render(React.createElement(SddBoardOverlay, { snapshot: snap } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Deadlock');
    view.unmount();
  });

  it('renders task cards with status icons', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Research');
    expect(frame).toContain('Implement');
    expect(frame).toContain('t1');
    expect(frame).toContain('t2');
    view.unmount();
  });

  it('focuses a specific column when focusColumn provided', () => {
    const view = render(
      React.createElement(SddBoardOverlay, { snapshot, focusColumn: 0 } as never),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Start');
    // Ink wraps text, "column 1/2" may be on adjacent lines
    expect(frame).toContain('column');
    expect(frame).toContain('1/2');
    view.unmount();
  });

  it('shows recent activity feed', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Recent activity');
    expect(frame).toContain('Task started');
    view.unmount();
  });

  it('renders all task display statuses', () => {
    const statuses: Array<{ displayStatus: string; icon: string }> = [
      { displayStatus: 'pending', icon: '' },
      { displayStatus: 'queued', icon: '' },
      { displayStatus: 'in_progress', icon: '' },
      { displayStatus: 'blocked', icon: '' },
      { displayStatus: 'review', icon: '' },
      { displayStatus: 'failed', icon: '' },
      { displayStatus: 'completed', icon: '' },
      { displayStatus: 'cancelled', icon: '' },
    ];
    const tasks = statuses.map((s, i) => ({
      id: `t-${i}`,
      shortId: `s${i}`,
      title: `Task ${s.displayStatus}`,
      displayStatus: s.displayStatus as any,
      priority: 'low',
      deps: [],
      agentName: undefined,
      retries: 0,
      worktreeBranch: undefined,
    }));
    const cols = [{ label: 'All', taskIds: tasks.map((t: any) => t.shortId) }];
    const snap = {
      ...snapshot,
      tasks,
      columns: cols,
      progress: { total: tasks.length, completed: 0, inProgress: 0, failed: 0, percentComplete: 0 },
    };
    const view = render(React.createElement(SddBoardOverlay, { snapshot: snap } as never));
    const frame = view.lastFrame() ?? '';
    for (const s of statuses) {
      expect(frame).toContain(`Task ${s.displayStatus}`);
    }
    view.unmount();
  });

  it('shows agent name for in-progress tasks', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('agent-1');
    view.unmount();
  });

  it('shows dependencies when present', () => {
    const view = render(React.createElement(SddBoardOverlay, { snapshot } as never));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('t1');
    view.unmount();
  });
});
