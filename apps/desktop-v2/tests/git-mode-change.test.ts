import { describe, expect, it } from 'vitest';
import { modeChangeNote } from '../src/GitHunkReview';

describe('mode change note', () => {
  it('explains that content hunks leave the mode change to the whole-file controls', () => {
    expect(modeChangeNote({ from: '100644', to: '100755' })).toMatch(
      /100644 → 100755.*content only.*whole-file controls/,
    );
    expect(modeChangeNote(undefined)).toBe('');
  });
});
