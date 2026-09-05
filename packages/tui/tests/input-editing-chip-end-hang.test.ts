import { describe, expect, it } from 'vitest';
import { deleteWordForward, nextInputWordStart } from '../src/input-editing.js';

/**
 * Regression: `nextInputWordStart` looped forever when the cursor sat exactly
 * on a chip's end with a word character following (`tokenSpanAt` matches
 * inclusively at `end`, so `i = chip.end` made no progress). Ctrl+Right and
 * Ctrl+Delete froze the TUI. See input-editing.ts (forward word walk).
 */
describe('nextInputWordStart chip-end boundary', () => {
  it('advances past a word immediately after a chip instead of looping', () => {
    expect(nextInputWordStart('[pasted #1]abc', 11)).toBe(14);
  });

  it('terminates via Ctrl+Delete path at the same boundary', () => {
    expect(deleteWordForward('[pasted #1]abc', 11)).toEqual({
      buffer: '[pasted #1]',
      cursor: 11,
    });
  });

  it('keeps prior chip and word semantics', () => {
    expect(nextInputWordStart('[pasted #1]', 11)).toBe(11); // chip-only buffer
    expect(nextInputWordStart('[pasted #1] abc', 11)).toBe(12); // lands ON next word
    expect(nextInputWordStart('[pasted #1]abc', 5)).toBe(11); // inside chip → chip end
    expect(nextInputWordStart('hello world', 0)).toBe(6);
    expect(nextInputWordStart('hello world', 6)).toBe(11);
    expect(nextInputWordStart('', 0)).toBe(0);
  });
});
