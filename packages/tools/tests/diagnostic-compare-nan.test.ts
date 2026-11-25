import { describe, expect, it } from 'vitest';
import { compareDiagnostics } from '../src/languages/diagnostic-normalization.js';

describe('compareDiagnostics non-finite coordinates', () => {
  it('maintains strict weak ordering when line or column is NaN', () => {
    const a = {
      severity: 'error' as const,
      message: 'b',
      file: 'x.ts',
      range: { start: { line: Number.NaN, column: 1 } },
      source: 'tsc',
    };
    const b = {
      severity: 'error' as const,
      message: 'a',
      file: 'x.ts',
      range: { start: { line: 5, column: 1 } },
      source: 'tsc',
    };
    const c = {
      severity: 'error' as const,
      message: 'c',
      file: 'x.ts',
      range: { start: { line: 10, column: 1 } },
      source: 'tsc',
    };
    expect(compareDiagnostics(a, b)).toBeLessThan(0);
    expect(compareDiagnostics(b, c)).toBeLessThan(0);
    expect(compareDiagnostics(a, c)).toBeLessThan(0);
    expect(compareDiagnostics(b, a)).toBeGreaterThan(0);
  });
});
