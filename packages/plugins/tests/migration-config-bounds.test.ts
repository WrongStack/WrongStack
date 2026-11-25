import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/migration-planner/migration-config.js';

describe('migration-config normalization', () => {
  it('trims changelogPaths, drops blanks, and floors fractional limits', () => {
    const cfg = readConfig({
      changelogPaths: ['  ', ' CHANGELOG.md '],
      maxChars: 1500.7,
      maxLlmChars: 1200.9,
    });
    expect(cfg.changelogPaths).toEqual(['CHANGELOG.md']);
    expect(cfg.maxChars).toBe(1500);
    expect(cfg.maxLlmChars).toBe(1200);
  });
});
