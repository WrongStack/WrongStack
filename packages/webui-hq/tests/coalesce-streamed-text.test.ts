import type { HqTranscriptEntry } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { coalesceStreamedText } from '../src/domain/use-session-transcript.js';

const E = (over: Partial<HqTranscriptEntry> & { text: string }): HqTranscriptEntry => ({
  ts: '2026-07-10T00:00:00.000Z',
  role: 'assistant',
  ...over,
});

describe('coalesceStreamedText', () => {
  it('merges consecutive assistant deltas into one turn', () => {
    const out = coalesceStreamedText([
      E({ text: 'Hel', ts: 't1' }),
      E({ text: 'lo ', ts: 't2' }),
      E({ text: 'world', ts: 't3' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.text).toBe('Hello world');
    // Keeps the earliest ts for stable ordering.
    expect(out[0]!.ts).toBe('t1');
  });

  it('breaks a turn at a tool call', () => {
    const out = coalesceStreamedText([
      E({ text: 'let me ', ts: 't1' }),
      E({ text: 'check', ts: 't2' }),
      E({ role: 'tool', tool: 'grep', text: '', toolUseId: 'u1', ts: 't3' }),
      E({ text: 'found ', ts: 't4' }),
      E({ text: 'it', ts: 't5' }),
    ]);
    expect(out.map((e) => e.text)).toEqual(['let me check', '', 'found it']);
    expect(out[1]!.role).toBe('tool');
  });

  it('does not merge across different agents', () => {
    const out = coalesceStreamedText([
      E({ text: 'from A', agentId: 'a' }),
      E({ text: 'from B', agentId: 'b' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('does not merge assistant into thinking', () => {
    const out = coalesceStreamedText([
      E({ role: 'thinking', text: 'hmm' }),
      E({ role: 'assistant', text: 'answer' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('keeps error entries separate', () => {
    const out = coalesceStreamedText([
      E({ text: 'ok' }),
      E({ role: 'error', isError: true, text: 'boom' }),
      E({ text: 'recovered' }),
    ]);
    expect(out).toHaveLength(3);
  });

  it('is a no-op on already-whole turns separated by tools', () => {
    const input = [
      E({ text: 'one whole message' }),
      E({ role: 'tool', tool: 'edit', text: 'done', toolUseId: 'u1' }),
      E({ text: 'another whole message' }),
    ];
    expect(coalesceStreamedText(input).map((e) => e.text)).toEqual([
      'one whole message',
      'done',
      'another whole message',
    ]);
  });
});
