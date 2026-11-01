import { describe, expect, it } from 'vitest';
import {
  agentNameMap,
  isFailedTool,
  isToolEntry,
  speakerLabel,
} from '../src/features/transcript/model';

describe('transcript tool rows', () => {
  it('treats a failed call merged into an error entry as a failed tool row', () => {
    const merged = { role: 'error' as const, toolInput: '{"pattern":"("}' };
    expect(isToolEntry(merged)).toBe(true);
    expect(isFailedTool(merged)).toBe(true);
  });

  it('keeps a plain error message out of the tool rows', () => {
    expect(isToolEntry({ role: 'error' as const, toolInput: undefined })).toBe(false);
  });

  it('reads isError on a tool entry as failure and its absence as success', () => {
    expect(isFailedTool({ role: 'tool' as const, isError: true })).toBe(true);
    expect(isFailedTool({ role: 'tool' as const })).toBe(false);
  });
});

describe('speakerLabel', () => {
  const names = agentNameMap([
    { id: 'a2', name: 'reviewer' },
    { id: 'leader', name: 'leader' },
  ]);

  it('names subagents from the roster and keeps the leader as the default voice', () => {
    expect(speakerLabel('a2', 'Agent', names)).toBe('reviewer');
    expect(speakerLabel('leader', 'Agent', names)).toBe('Agent');
    expect(speakerLabel(undefined, 'You', names)).toBe('You');
  });

  it('falls back to the raw id once the roster no longer lists the agent', () => {
    expect(speakerLabel('a9', 'Agent', names)).toBe('a9');
    expect(speakerLabel('a9', 'Agent')).toBe('a9');
  });
});
