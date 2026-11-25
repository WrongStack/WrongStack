import { describe, expect, it } from 'vitest';
import {
  deleteWordBackward,
  deleteWordForward,
  nextInputWordStart,
  previousInputWordStart,
} from '../src/input-editing.js';

describe('input-editing cursor bounds (F1992)', () => {
  it('clamps non-finite and negative cursors safely', () => {
    expect(previousInputWordStart('hello world', Number.NaN)).toBe(0);
    expect(nextInputWordStart('hello world', Number.NaN)).toBe(6);
    expect(deleteWordBackward('hello world', -5)).toBeNull();
    expect(deleteWordForward('hello world', Number.NaN)?.buffer).toBe('world');
  });
});
