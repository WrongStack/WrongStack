import { describe, expect, it } from 'vitest';
import { mapSessionEventToEntries } from '../src/transcript-mapper.js';

describe('mapSessionEventToEntries non-finite durationMs guard', () => {
  it('drops NaN and Infinity durationMs on tool_call_end events', () => {
    expect(
      mapSessionEventToEntries({
        type: 'tool_call_end',
        ts: '2026-01-01T00:00:00Z',
        name: 'read',
        durationMs: Number.NaN,
      }),
    ).toEqual([]);

    const withOutput = mapSessionEventToEntries({
      type: 'tool_call_end',
      ts: '2026-01-01T00:00:00Z',
      name: 'read',
      output: 'done',
      durationMs: Number.POSITIVE_INFINITY,
    });
    expect(withOutput).toHaveLength(1);
    expect(withOutput[0]?.durationMs).toBeUndefined();
  });
});
