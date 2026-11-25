import { describe, expect, it } from 'vitest';
import { worktreeBarRuns } from '../src/components/worktree-timeline-bars.js';

describe('worktreeBarRuns non-finite bounds guard', () => {
  it('renders segments when end is NaN and returns empty array for NaN width', () => {
    const runs = worktreeBarRuns(
      { segments: [{ start: 0, end: 50, phase: 'working' }] } as unknown as Parameters<
        typeof worktreeBarRuns
      >[0],
      0,
      Number.NaN,
      10,
    );
    expect(runs.some((r) => r.phase === 'working')).toBe(true);
    expect(runs.reduce((n, r) => n + r.text.length, 0)).toBe(10);
    expect(
      worktreeBarRuns(
        { segments: [] } as unknown as Parameters<typeof worktreeBarRuns>[0],
        0,
        100,
        Number.NaN,
      ),
    ).toEqual([]);
  });
});
