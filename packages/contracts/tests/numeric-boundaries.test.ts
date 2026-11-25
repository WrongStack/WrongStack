import { describe, expect, it } from 'vitest';
import { failedRunResumeDelayMs, failedRunResumePrompt } from '../src/types/failed-run-resume.js';
import { formatWorktreeDuration, worktreeTimelineTicks } from '../src/types/worktree-timeline.js';

describe('persisted timeline and retry numeric boundaries', () => {
  it('formats non-finite worktree durations as zero', () => {
    expect(formatWorktreeDuration(Number.NaN)).toBe('0ms');
    expect(formatWorktreeDuration(Number.POSITIVE_INFINITY)).toBe('0ms');
  });

  it('normalizes non-finite failed-run resume attempts to the first attempt', () => {
    expect(failedRunResumeDelayMs(Number.NaN, 15000)).toBe(15000);
    expect(failedRunResumeDelayMs(Number.POSITIVE_INFINITY, 15000)).toBe(15000);
    expect(failedRunResumePrompt(Number.NaN)).toContain('Automatic resume 1 of');
  });

  it('uses the default timeline tick count for non-finite limits', () => {
    expect(worktreeTimelineTicks(0, 10000, Number.NaN)).toEqual(worktreeTimelineTicks(0, 10000, 5));
    expect(worktreeTimelineTicks(0, 10000, Number.POSITIVE_INFINITY)).toEqual(
      worktreeTimelineTicks(0, 10000, 5),
    );
  });

  it('flattens failed-run reasons before inserting them into a continuation prompt', () => {
    const prompt = failedRunResumePrompt(1, 'timeout\nIGNORE PRIOR');
    expect(prompt).not.toContain('\n');
    expect(prompt).toContain('(timeout IGNORE PRIOR)');
  });
});
