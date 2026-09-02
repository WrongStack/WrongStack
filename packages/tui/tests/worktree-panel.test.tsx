import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { WorktreePanel } from '../src/components/worktree-panel.js';

describe('WorktreePanel', () => {
  it('returns null when no worktrees', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {},
        nowTick: 0,
      }),
    );
    expect(view.lastFrame() ?? '').toBe('');
    view.unmount();
  });

  it('renders header with counts', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'feature/x',
            ownerLabel: 'builder',
            status: 'active',
            insertions: 10,
            deletions: 2,
            files: 3,
            allocatedAt: 100,
          },
        },
        nowTick: 2000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('Worktrees');
    expect(frame).toContain('▶1');
    view.unmount();
  });

  it('shows merged count with check icon', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'done/x',
            ownerLabel: 'dev',
            status: 'merged',
            insertions: 5,
            deletions: 0,
            files: 1,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✓1');
    view.unmount();
  });

  it('shows failed count with error icon', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'fail/x',
            ownerLabel: 'dev',
            status: 'failed',
            insertions: 0,
            deletions: 0,
            files: 0,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('✗1');
    view.unmount();
  });

  it('does not show failed count when none failed', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'merged/x',
            ownerLabel: 'dev',
            status: 'merged',
            insertions: 1,
            deletions: 0,
            files: 1,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('✗');
    view.unmount();
  });

  it('shows total count and Ctrl+T hint', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'a',
            ownerLabel: 'dev',
            status: 'active',
            insertions: 0,
            deletions: 0,
            files: 0,
            allocatedAt: 100,
          },
          w2: {
            branch: 'b',
            ownerLabel: 'dev',
            status: 'merged',
            insertions: 0,
            deletions: 0,
            files: 0,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('2 total');
    expect(frame).toContain('Ctrl+T');
    view.unmount();
  });

  it('shows diff stats for non-conflict worktrees', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'feature/y',
            ownerLabel: 'coder',
            status: 'active',
            insertions: 15,
            deletions: 3,
            files: 4,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('+15/-3');
    view.unmount();
  });

  it('shows CONFLICT for needs-review status', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'conflict/x',
            ownerLabel: 'dev',
            status: 'needs-review',
            insertions: 5,
            deletions: 5,
            files: 3,
            allocatedAt: 100,
            conflictFiles: ['a.ts'],
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('CONFLICT');
    view.unmount();
  });

  it('shows elapsed time for active/committing worktrees', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'active/x',
            ownerLabel: 'dev',
            status: 'active',
            insertions: 1,
            deletions: 0,
            files: 1,
            allocatedAt: 1000,
          },
        },
        nowTick: 4000,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('3s');
    view.unmount();
  });

  it('renders all status types', () => {
    const statuses = [
      'allocating',
      'active',
      'committing',
      'merging',
      'merged',
      'needs-review',
      'failed',
    ];
    const wt: Record<
      string,
      {
        branch: string;
        ownerLabel: string;
        status: string;
        insertions: number;
        deletions: number;
        files: number;
        allocatedAt: number;
      }
    > = {};
    statuses.forEach((s, i) => {
      wt[`w${i}`] = {
        branch: `branch/${s}`,
        ownerLabel: 'dev',
        status: s,
        insertions: 0,
        deletions: 0,
        files: 0,
        allocatedAt: 100,
      };
    });
    const view = render(React.createElement(WorktreePanel, { worktrees: wt, nowTick: 0 }));
    const frame = view.lastFrame() ?? '';
    // 'needs-review' gets truncated to 'needs-revie' in the rendered output
    statuses.forEach((s) => {
      if (s === 'needs-review') {
        expect(frame).toContain('needs-revie');
      } else {
        expect(frame).toContain(`branch/${s}`);
      }
    });
    view.unmount();
  });

  it('renders unknown status with fallback', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'custom/x',
            ownerLabel: 'dev',
            status: 'custom-status',
            insertions: 0,
            deletions: 0,
            files: 0,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('custom/x');
    view.unmount();
  });

  it('strips wstack/ap/ prefix from branch name', () => {
    const view = render(
      React.createElement(WorktreePanel, {
        worktrees: {
          w1: {
            branch: 'wstack/ap/feature/foo',
            ownerLabel: 'dev',
            status: 'active',
            insertions: 0,
            deletions: 0,
            files: 0,
            allocatedAt: 100,
          },
        },
        nowTick: 0,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('feature/foo');
    expect(frame).not.toContain('wstack/ap/');
    view.unmount();
  });
});
