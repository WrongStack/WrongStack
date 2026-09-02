/**
 * Unit tests for the Live Console transcript accumulator — exactly-once batch
 * consumption, live tool-result merging by toolUseId, and fetch/stream
 * overlap dedup. This is the layer that fixes the old console's
 * "re-append the whole ring on every event" duplication bug.
 */
import type { HqTranscriptEntry } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import {
  applyFetch,
  applyLiveBatch,
  createTranscriptState,
  entryKey,
  isToolRunning,
} from '../src/domain/transcript-store.js';

function e(partial: Partial<HqTranscriptEntry>): HqTranscriptEntry {
  return { ts: 't0', role: 'assistant', text: 'hi', ...partial };
}

describe('applyFetch', () => {
  it('replaces state with the fetched history and indexes open tool cards', () => {
    const s = applyFetch(createTranscriptState(), [
      e({ role: 'user', text: 'run it' }),
      e({ role: 'tool', tool: 'bash', toolInput: '{"command":"ls"}', text: '', toolUseId: 'tu1' }),
    ]);
    expect(s.entries).toHaveLength(2);
    expect(s.openTools.get('tu1')).toBe(1);
  });

  it('dedupes identical entries inside the fetch itself', () => {
    const dup = e({ role: 'user', text: 'same' });
    const s = applyFetch(createTranscriptState(), [dup, dup]);
    expect(s.entries).toHaveLength(1);
  });

  it('merges stream-ring result halves during the fetch (remote sessions)', () => {
    // A remote session's ring history still carries separate args/result
    // entries — the fetch must fold them like the live path does.
    const s = applyFetch(createTranscriptState(), [
      e({ role: 'tool', tool: 'bash', toolInput: '{"command":"ls"}', text: '', toolUseId: 'tu1' }),
      e({
        role: 'tool',
        tool: '↳ result',
        text: 'out\nexit code: 0',
        toolUseId: 'tu1',
        durationMs: 5,
      }),
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.text).toContain('out');
    expect(s.entries[0]!.durationMs).toBe(5);
  });
});

describe('applyLiveBatch', () => {
  it('consumes a batch exactly once (same fromSeq is a no-op)', () => {
    let s = applyFetch(createTranscriptState(), []);
    const batch = [e({ role: 'assistant', text: 'step 1' })];
    s = applyLiveBatch(s, 0, batch);
    const again = applyLiveBatch(s, 0, batch);
    expect(again).toBe(s); // identical object — no re-render
    expect(s.entries).toHaveLength(1);
  });

  it('merges a live result entry into the open tool card by toolUseId', () => {
    let s = applyFetch(createTranscriptState(), []);
    s = applyLiveBatch(s, 0, [
      e({ role: 'tool', tool: 'bash', toolInput: '{"command":"ls"}', text: '', toolUseId: 'tu1' }),
    ]);
    expect(isToolRunning(s.entries[0]!)).toBe(true);

    s = applyLiveBatch(s, 1, [
      e({ role: 'tool', tool: '↳ result', text: 'file1\nfile2', toolUseId: 'tu1', durationMs: 40 }),
    ]);
    expect(s.entries).toHaveLength(1); // merged, not appended
    expect(s.entries[0]!.text).toBe('file1\nfile2');
    expect(s.entries[0]!.durationMs).toBe(40);
    expect(isToolRunning(s.entries[0]!)).toBe(false);
  });

  it('flips the card to error when the live result is an error', () => {
    let s = applyLiveBatch(createTranscriptState(), 0, [
      e({ role: 'tool', tool: 'bash', toolInput: '{"command":"x"}', text: '', toolUseId: 'tu1' }),
    ]);
    s = applyLiveBatch(s, 1, [e({ role: 'error', text: 'boom', toolUseId: 'tu1', isError: true })]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.role).toBe('error');
    expect(s.entries[0]!.isError).toBe(true);
  });

  it('keeps an orphan result (no open card) as its own entry', () => {
    const s = applyLiveBatch(createTranscriptState(), 0, [
      e({ role: 'tool', tool: '↳ result', text: 'out', toolUseId: 'tu-unknown' }),
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.text).toBe('out');
  });

  it('drops entries the fetch already delivered (overlap dedup)', () => {
    const known = e({ role: 'assistant', text: 'already here' });
    let s = applyFetch(createTranscriptState(), [known]);
    s = applyLiveBatch(s, 0, [known, e({ role: 'assistant', text: 'new one' })]);
    expect(s.entries.map((x) => x.text)).toEqual(['already here', 'new one']);
  });

  it('does not mutate the previous state (new revision object)', () => {
    const s0 = applyFetch(createTranscriptState(), []);
    const s1 = applyLiveBatch(s0, 0, [e({ role: 'user', text: 'x' })]);
    expect(s0.entries).toHaveLength(0);
    expect(s1.entries).toHaveLength(1);
    expect(s1.rev).toBeGreaterThan(s0.rev);
  });

  it('returns the same state when entries array is empty (line 111 guard)', () => {
    const s = applyFetch(createTranscriptState(), [e({ role: 'user', text: 'hello' })]);
    const result = applyLiveBatch(s, 0, []);
    expect(result).toBe(s); // same reference — no re-render
    expect(result.entries).toHaveLength(1);
  });

  it('derives batch key from first entry when fromSeq is undefined (line 112–113)', () => {
    // When fromSeq is undefined, the batch key is derived from entryKey of
    // the first entry + the batch length. This path is exercised by callers
    // that cannot supply a sequence number.
    const s = applyFetch(createTranscriptState(), []);
    const batch = [e({ role: 'assistant', text: 'step 1' })];
    const s1 = applyLiveBatch(s, undefined, batch);
    expect(s1.entries).toHaveLength(1);
    // Calling again with the same entries (and no fromSeq) should be a no-op.
    const s2 = applyLiveBatch(s1, undefined, batch);
    expect(s2).toBe(s1);
  });

  it('uses empty-string fallback when live result has no text (line 64 || fallback)', () => {
    let s = applyFetch(createTranscriptState(), []);
    s = applyLiveBatch(s, 0, [
      e({ role: 'tool', tool: 'bash', toolInput: '{"cmd":"ls"}', text: '', toolUseId: 'tu1' }),
    ]);
    // Merged result entry has empty text → tgt.text should be ''.
    s = applyLiveBatch(s, 1, [
      e({ role: 'tool', text: '', toolUseId: 'tu1', durationMs: 10 }),
    ]);
    expect(s.entries).toHaveLength(1);
    expect(s.entries[0]!.text).toBe('');
    expect(s.entries[0]!.durationMs).toBe(10);
  });
});

describe('entryKey', () => {
  it('keys tool args entries by toolUseId and text entries by content', () => {
    expect(entryKey(e({ role: 'tool', tool: 'bash', toolInput: '{}', toolUseId: 'tu1' }))).toBe(
      'tu:tu1',
    );
    expect(entryKey(e({ role: 'user', text: 'hi' }))).toContain('user');
  });
});
