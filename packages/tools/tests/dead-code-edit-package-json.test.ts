import { describe, expect, it } from 'vitest';
import { editPackageJson } from '../src/dead-code/fix-edits.js';

describe('editPackageJson malformed JSON resilience (F375)', () => {
  it('returns input text unchanged when package.json is invalid JSON', () => {
    const raw = '{NOT_VALID_JSON';
    expect(editPackageJson(raw, [{ field: 'dependencies', dep: 'unused' }])).toBe(raw);
  });
});
