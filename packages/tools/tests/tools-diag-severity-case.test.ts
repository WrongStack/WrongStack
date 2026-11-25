import { describe, expect, it } from 'vitest';
import { normalizeSeverity } from '../src/languages/diagnostic-normalization.js';

describe('normalizeSeverity case/whitespace normalization (F2269)', () => {
  it('normalizes uppercase and padded warning/info/hint severities', () => {
    expect(normalizeSeverity('WARNING')).toBe('warning');
    expect(normalizeSeverity(' Info ')).toBe('info');
    expect(normalizeSeverity('HINT')).toBe('hint');
  });
});
