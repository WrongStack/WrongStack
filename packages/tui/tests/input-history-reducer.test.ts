import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import type { State } from '../src/app-state.js';

/**
 * Minimal state factory for input-history reducer tests.
 *
 * The full AppState shape is large (~100 fields); only the slice the
 * history-related actions touch is needed here. We cast through
 * `unknown` exactly like `tests/reducer.test.ts` does — the reducer reads
 * only `inputHistory`/`historyIndex`/`buffer`/`cursor` for these actions,
 * so the rest can stay undefined.
 */
function historyState(over: Partial<State> = {}): State {
  return {
    inputHistory: [],
    historyIndex: 0,
    historyDraft: '',
    buffer: '',
    cursor: 0,
    ...over,
  } as unknown as State;
}

describe('input history reducer — historyPush', () => {
  it('adds a non-empty entry to the front of the history', () => {
    const s = reducer(historyState(), { type: 'historyPush', text: 'hello' });
    expect(s.inputHistory).toEqual(['hello']);
  });

  it('ignores an empty string (no-op, returns same ref)', () => {
    const before = historyState({ inputHistory: ['existing'] });
    const after = reducer(before, { type: 'historyPush', text: '' });
    expect(after).toBe(before);
  });

  it('ignores a duplicate of the most recent entry (no-op, returns same ref)', () => {
    const before = historyState({ inputHistory: ['same', 'older'] });
    const after = reducer(before, { type: 'historyPush', text: 'same' });
    expect(after).toBe(before);
    expect(after.inputHistory).toEqual(['same', 'older']);
  });

  it('pushes a new entry ahead of an existing one', () => {
    const s = reducer(historyState({ inputHistory: ['old'] }), {
      type: 'historyPush',
      text: 'new',
    });
    expect(s.inputHistory).toEqual(['new', 'old']);
  });

  it('caps the history at 100 entries (oldest dropped)', () => {
    // Fill exactly to the cap, then push one more.
    const filled = Array.from({ length: 100 }, (_, i) => `entry-${i}`);
    const s = reducer(historyState({ inputHistory: filled }), {
      type: 'historyPush',
      text: 'overflow',
    });
    expect(s.inputHistory).toHaveLength(100);
    expect(s.inputHistory[0]).toBe('overflow');
    // History is newest-first, so the tail (index 99) is the oldest.
    // Adding one and slicing to 100 drops the previous tail (entry-99).
    // Result: [overflow, entry-0, entry-1, ..., entry-98].
    expect(s.inputHistory[1]).toBe('entry-0');
    expect(s.inputHistory[99]).toBe('entry-98');
    expect(s.inputHistory).not.toContain('entry-99');
  });
});

describe('input history reducer — historyUp', () => {
  it('is a no-op when history is empty (returns same ref)', () => {
    const before = historyState();
    const after = reducer(before, { type: 'historyUp' });
    expect(after).toBe(before);
  });

  it('moves index 0 -> 1 and loads the most recent entry', () => {
    const s = reducer(historyState({ inputHistory: ['first', 'second'] }), {
      type: 'historyUp',
    });
    expect(s.historyIndex).toBe(1);
    expect(s.buffer).toBe('first');
    expect(s.cursor).toBe('first'.length);
  });

  it('walks further back on repeated historyUp (1 -> 2)', () => {
    let s = historyState({ inputHistory: ['first', 'second', 'third'] });
    s = reducer(s, { type: 'historyUp' }); // -> index 1, "first"
    s = reducer(s, { type: 'historyUp' }); // -> index 2, "second"
    expect(s.historyIndex).toBe(2);
    expect(s.buffer).toBe('second');
    expect(s.cursor).toBe('second'.length);
  });

  it('clamps at the oldest entry (does not overshoot)', () => {
    let s = historyState({ inputHistory: ['only'] });
    s = reducer(s, { type: 'historyUp' }); // -> index 1
    s = reducer(s, { type: 'historyUp' }); // already at end, stays
    expect(s.historyIndex).toBe(1);
    expect(s.buffer).toBe('only');
  });

  it('places the cursor at the end of the loaded entry', () => {
    const s = reducer(historyState({ inputHistory: ['hi there'] }), {
      type: 'historyUp',
    });
    expect(s.cursor).toBe('hi there'.length);
  });
});

describe('input history reducer — historyDown', () => {
  it('is a no-op when already at index 0 (returns same ref)', () => {
    const before = historyState({ historyIndex: 0 });
    const after = reducer(before, { type: 'historyDown' });
    expect(after).toBe(before);
  });

  it('moves index 1 -> 0 and clears the buffer', () => {
    const s = reducer(historyState({ inputHistory: ['first'], historyIndex: 1, buffer: 'first' }), {
      type: 'historyDown',
    });
    expect(s.historyIndex).toBe(0);
    expect(s.buffer).toBe('');
    expect(s.cursor).toBe(0);
  });

  it('walks forward toward the most recent (2 -> 1)', () => {
    let s = historyState({
      inputHistory: ['first', 'second'],
      historyIndex: 2,
      buffer: 'second',
    });
    s = reducer(s, { type: 'historyDown' });
    expect(s.historyIndex).toBe(1);
    expect(s.buffer).toBe('first');
  });

  it('returns an empty buffer when reaching index 0', () => {
    let s = historyState({
      inputHistory: ['first', 'second'],
      historyIndex: 2,
    });
    s = reducer(s, { type: 'historyDown' }); // 2 -> 1, "first"
    s = reducer(s, { type: 'historyDown' }); // 1 -> 0, ""
    expect(s.historyIndex).toBe(0);
    expect(s.buffer).toBe('');
  });
});

describe('input history reducer — clearInput interaction', () => {
  it('resets historyIndex to 0 (exits history navigation)', () => {
    const s = reducer(
      historyState({ inputHistory: ['x'], historyIndex: 1, buffer: 'x', cursor: 1 }),
      { type: 'clearInput' },
    );
    expect(s.historyIndex).toBe(0);
  });
});

/**
 * Draft preservation across history navigation (Adım 3 fix).
 *
 * Before this fix, peeking at history with Up and coming back with Down
 * discarded the user's half-typed prompt: `historyDown` to index 0 hard-
 * coded the buffer to ''. The fix snapshots the draft on the first Up
 * (via `state.historyDraft`) and restores it on the way back down.
 */
describe('input history — draft preservation across navigation (Adım 3)', () => {
  it('preserves the in-progress draft when returning to index 0', () => {
    let s = historyState({
      inputHistory: ['previous'],
      buffer: 'half-typed',
      cursor: 10,
    });
    s = reducer(s, { type: 'historyUp' }); // peek at "previous"
    expect(s.buffer).toBe('previous');
    s = reducer(s, { type: 'historyDown' }); // back to index 0
    expect(s.buffer).toBe('half-typed');
    expect(s.cursor).toBe(10);
    // The draft snapshot is cleared once we're back at the buffer.
    expect(s.historyDraft).toBe('');
  });

  it('captures the draft only on the first Up (not on subsequent navigation)', () => {
    let s = historyState({
      inputHistory: ['first', 'second'],
      buffer: 'original-draft',
      cursor: 14,
    });
    s = reducer(s, { type: 'historyUp' }); // -> "first", snapshot "original-draft"
    expect(s.historyDraft).toBe('original-draft');
    // Edit the buffer mentally — but the snapshot must NOT change as we
    // keep walking up. It still holds the original draft.
    s = reducer(s, { type: 'historyUp' }); // -> "second"
    expect(s.historyDraft).toBe('original-draft');
    expect(s.buffer).toBe('second');
  });

  it('clears historyDraft on clearInput', () => {
    const s = reducer(
      historyState({ inputHistory: ['x'], historyIndex: 1, buffer: 'x', historyDraft: 'leftover' }),
      { type: 'clearInput' },
    );
    expect(s.historyDraft).toBe('');
    expect(s.historyIndex).toBe(0);
  });

  it('restores an empty draft when history was entered with an empty buffer', () => {
    let s = historyState({ inputHistory: ['only'], buffer: '', cursor: 0 });
    s = reducer(s, { type: 'historyUp' });
    s = reducer(s, { type: 'historyDown' });
    expect(s.buffer).toBe('');
    expect(s.historyDraft).toBe('');
  });
});

describe('input history reducer — setInputHistory (persistence load)', () => {
  it('replaces the entire history in one shot', () => {
    const s = reducer(historyState(), {
      type: 'setInputHistory',
      entries: ['a', 'b', 'c'],
    });
    expect(s.inputHistory).toEqual(['a', 'b', 'c']);
  });

  it('does not touch buffer/cursor/historyIndex (only the list)', () => {
    const s = reducer(historyState({ buffer: 'typed', cursor: 5, historyIndex: 0 }), {
      type: 'setInputHistory',
      entries: ['loaded'],
    });
    expect(s.buffer).toBe('typed');
    expect(s.cursor).toBe(5);
    expect(s.historyIndex).toBe(0);
  });

  it('caps at 100 entries on load (defensive)', () => {
    const many = Array.from({ length: 150 }, (_, i) => `e-${i}`);
    const s = reducer(historyState(), { type: 'setInputHistory', entries: many });
    expect(s.inputHistory).toHaveLength(100);
  });

  it('accepts an empty list (loaded empty stays empty)', () => {
    const s = reducer(historyState({ inputHistory: ['stale'] }), {
      type: 'setInputHistory',
      entries: [],
    });
    expect(s.inputHistory).toEqual([]);
  });
});

describe('input history reducer — clearInputHistory', () => {
  it('empties the history and resets navigation state', () => {
    const s = reducer(
      historyState({
        inputHistory: ['a', 'b'],
        historyIndex: 1,
        buffer: 'a',
        historyDraft: 'leftover',
      }),
      { type: 'clearInputHistory' },
    );
    expect(s.inputHistory).toEqual([]);
    expect(s.historyIndex).toBe(0);
    expect(s.historyDraft).toBe('');
  });
});
