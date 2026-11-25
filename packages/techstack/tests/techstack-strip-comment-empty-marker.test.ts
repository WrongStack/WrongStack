import { describe, expect, it } from 'vitest';
import { stripInlineComment } from '../src/adapters/parse-utils.js';

describe('stripInlineComment empty marker guard', () => {
  it('returns the original line unchanged when marker is empty', () => {
    expect(stripInlineComment('version = "1.0.0"', '')).toBe('version = "1.0.0"');
    expect(stripInlineComment('version = "1.0.0" # note', '#')).toBe('version = "1.0.0"');
  });
});
