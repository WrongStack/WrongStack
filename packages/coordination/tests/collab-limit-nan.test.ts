import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_TARGET_FILES, effectiveCollabFileLimit } from '../src/collab-snapshot.js';

describe('effectiveCollabFileLimit non-finite option guards', () => {
  it('falls back to DEFAULT_MAX_TARGET_FILES for non-finite or non-positive inputs', () => {
    expect(effectiveCollabFileLimit({ targetPaths: [], maxTargetFiles: Number.NaN })).toBe(
      DEFAULT_MAX_TARGET_FILES,
    );
    expect(effectiveCollabFileLimit({ targetPaths: [], contextWindow: Number.NaN })).toBe(
      DEFAULT_MAX_TARGET_FILES,
    );
    expect(effectiveCollabFileLimit({ targetPaths: [], maxTargetFiles: -5 })).toBe(
      DEFAULT_MAX_TARGET_FILES,
    );
  });
});
