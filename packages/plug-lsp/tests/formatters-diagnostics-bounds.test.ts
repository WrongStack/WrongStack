import { describe, expect, it } from 'vitest';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { formatDiagnostics } from '../src/formatters/diagnostics.js';

describe('formatDiagnostics non-positive/non-finite limits', () => {
  it('returns empty output when maxPerFile is negative or NaN, or maxTotal is NaN', () => {
    const diags: Diagnostic[] = [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: 'e1',
      },
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
        severity: 1,
        message: 'e2',
      },
    ];
    const map = new Map([['/repo/a.ts', diags]]);

    expect(
      formatDiagnostics(map, {
        cwd: '/repo',
        severityFilter: ['error'],
        maxPerFile: -1,
        maxTotal: 10,
      }),
    ).toBe('No LSP diagnostics.');
    expect(
      formatDiagnostics(map, {
        cwd: '/repo',
        severityFilter: ['error'],
        maxPerFile: 5,
        maxTotal: Number.NaN,
      }),
    ).toBe('No LSP diagnostics.');
    expect(
      formatDiagnostics(map, {
        cwd: '/repo',
        severityFilter: ['error'],
        maxPerFile: Number.NaN,
        maxTotal: 10,
      }),
    ).toBe('No LSP diagnostics.');
  });
});
