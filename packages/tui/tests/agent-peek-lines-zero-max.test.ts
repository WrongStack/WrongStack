import { describe, expect, it } from 'vitest';
import { agentPeekLines } from '../src/background-strip-model.js';

const entry = {
  recentMessages: [{ text: 'line1\nline2\nline3' }],
  streamingText: 'stream1\nstream2',
  currentTool: { name: 'bash' },
} as unknown as Parameters<typeof agentPeekLines>[0];

describe('agentPeekLines max bounds', () => {
  it('returns empty array for zero, fractional < 1, negative, or NaN max', () => {
    expect(agentPeekLines(entry, 2)).toHaveLength(2);
    expect(agentPeekLines(entry, 0)).toEqual([]);
    expect(agentPeekLines(entry, 0.5)).toEqual([]);
    expect(agentPeekLines(entry, -1)).toEqual([]);
    expect(agentPeekLines(entry, Number.NaN)).toEqual([]);
  });
});
