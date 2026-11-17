import { describe, expect, it } from 'vitest';
import { buildAutomationResult } from '../src/automation/result.js';

describe('literal Unicode in C-quoted Git filenames', () => {
  it.each([
    ['+++ "b/src/😀\\".ts"\n', ['src/😀".ts']],
    ['+++ "b/src/ç\\".ts"\n', ['src/ç".ts']],
    ['+++ "b/\\360\\237\\230\\200.ts"\n', ['😀.ts']],
    ['rename from "😀\\".ts"\nrename to "🚀\\".ts"\n', ['😀".ts', '🚀".ts']],
  ])('preserves code points in %s', (patch, expected) => {
    expect(buildAutomationResult('', patch, 0).changedFiles).toEqual(expected);
  });
});
