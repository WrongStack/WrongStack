import { describe, expect, it } from 'vitest';
import { taskBriefPreview } from '../src/lib/task-brief-preview';

describe('taskBriefPreview maxChars bounds', () => {
  it('returns empty string for non-positive maxChars and falls back to default for NaN', () => {
    expect(taskBriefPreview('hello world', -1)).toBe('');
    expect(taskBriefPreview('hello world', 0)).toBe('');
    expect(taskBriefPreview('hello world', Number.NaN)).toBe('hello world');
    expect(taskBriefPreview('hello world', 5)).toBe('hello…');
  });
});
