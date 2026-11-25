import { describe, expect, it } from 'vitest';
import { progressBar } from '../src/components/user-input-draft.js';

describe('progressBar bounds and non-finite guards', () => {
  it('clamps negative, overflow, and NaN counts without throwing', () => {
    expect(progressBar(-1, 2, 10)).toBe('[░░░░░░░░░░]');
    expect(progressBar(5, 2, 10)).toBe('[██████████]');
    expect(progressBar(Number.NaN, 2, 10)).toBe('[░░░░░░░░░░]');
  });
});
