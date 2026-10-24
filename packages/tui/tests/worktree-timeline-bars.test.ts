import {
  projectWorktreeTimeline,
  type WorktreeTimelineEvent,
} from '@wrongstack/contracts/types/worktree-timeline';
import { describe, expect, it } from 'vitest';
import type { State } from '../src/app-state.js';
import {
  worktreeAxisLine,
  worktreeBarRuns,
  worktreeBaseRuns,
} from '../src/components/worktree-timeline-bars.js';
import { reduceWorkspacePanels } from '../src/reducers/workspace-panels.js';

const lane = (events: WorktreeTimelineEvent[], now: number) =>
  projectWorktreeTimeline(events, { now });

describe('worktreeBarRuns', () => {
  it('maps working → waiting → merging onto columns in proportion', () => {
    const t = lane(
      [
        { kind: 'allocated', at: 0, handleId: 'a', branch: 'wstack/ap/a' },
        { kind: 'committed', at: 50, handleId: 'a', committed: true },
        { kind: 'merging', at: 80, handleId: 'a' },
        { kind: 'merged', at: 100, handleId: 'a' },
      ],
      100,
    );
    const runs = worktreeBarRuns(t.lanes[0]!, 0, 100, 10);
    expect(runs).toEqual([
      { text: '▓▓▓▓▓', phase: 'working' },
      { text: '▒▒▒', phase: 'queued' },
      { text: '██', phase: 'merging' },
    ]);
  });

  it('keeps an instant step visible and leaves uncovered time blank', () => {
    const t = lane(
      [
        { kind: 'allocated', at: 0, handleId: 'a' },
        { kind: 'allocated', at: 60, handleId: 'b' },
        { kind: 'committed', at: 61, handleId: 'b', committed: true },
        { kind: 'merging', at: 62, handleId: 'b' },
        { kind: 'merged', at: 62, handleId: 'b' },
      ],
      100,
    );
    const runs = worktreeBarRuns(t.lanes[1]!, 0, 100, 10);
    expect(runs[0]).toEqual({ text: '      ', phase: null });
    // The 1ms working/queued slices still own a column each where they start.
    expect(runs.map((r) => r.phase)).toContain('working');
    expect(runs.reduce((n, r) => n + r.text.length, 0)).toBe(10);
  });
});

describe('worktreeBaseRuns / worktreeAxisLine', () => {
  it('puts a dot where each squash commit landed', () => {
    expect(
      worktreeBaseRuns(
        { start: 0, end: 100, baseCommits: [{ at: 55, handleId: 'a', branch: 'b' }] },
        10,
      ),
    ).toEqual([
      { text: '─────', commit: false },
      { text: '●', commit: true },
      { text: '────', commit: false },
    ]);
  });

  it('places tick labels without overlap', () => {
    const line = worktreeAxisLine([0, 10, 50, 100], 0, 100, 20, (at) => `t${at}`);
    expect(line).toHaveLength(20);
    expect(line.startsWith('t0')).toBe(true);
    expect(line).toContain('t50');
    expect(line.trimEnd().endsWith('t100')).toBe(true);
    // t10 would collide with t0 and is dropped.
    expect(line).not.toContain('t10 ');
  });
});

describe('worktree timeline reducer', () => {
  it('appends normalised events and keeps only the newest 500', () => {
    let state = { worktreeTimeline: [] } as unknown as State;
    for (let i = 0; i < 505; i++) {
      state = reduceWorkspacePanels(state, {
        type: 'worktreeTimelineEvent',
        event: { kind: 'released', at: i, handleId: `h${i}` },
      });
    }
    expect(state.worktreeTimeline).toHaveLength(500);
    expect(state.worktreeTimeline[0]?.handleId).toBe('h5');
  });
});
