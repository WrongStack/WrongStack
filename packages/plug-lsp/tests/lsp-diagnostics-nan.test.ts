import { describe, expect, it } from 'vitest';
import { formatDiagnostics } from '../src/formatters/diagnostics.js';

describe('formatDiagnostics non-finite coordinates', () => {
  it('clamps non-finite line and character coordinates to L1:1', () => {
    const out = formatDiagnostics(
      new Map([
        [
          '/repo/a.ts',
          [
            {
              severity: 1,
              message: 'boom',
              range: {
                start: { line: Number.NaN, character: Number.NaN },
                end: { line: 0, character: 1 },
              },
            },
          ],
        ],
      ]),
      { cwd: '/repo', severityFilter: ['error'], maxPerFile: 10, maxTotal: 10 },
    );
    expect(out).not.toContain('NaN');
    expect(out).toContain('L1:1 ERROR: boom');
  });
});
