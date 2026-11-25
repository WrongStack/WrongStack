import { describe, expect, it } from 'vitest';
import { normalizeExtensions, readConfig } from '../src/accessibility-auditor/a11y-config.js';

describe('a11y-config normalization', () => {
  it('trims and drops blank extensions and floors fractional maxFindings', () => {
    expect(normalizeExtensions([' tsx ', '', '.', '  .HTML '])).toEqual(['.tsx', '.html']);
    expect(readConfig({ maxFindings: 12.9 }).maxFindings).toBe(12);
    expect(readConfig({ maxFindings: Number.NaN }).maxFindings).toBe(50);
  });
});
