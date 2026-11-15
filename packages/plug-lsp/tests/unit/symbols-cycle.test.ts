import { describe, expect, it } from 'vitest';
import { symbolsCoverage } from '../../src/tools/symbols.js';

describe('formatSymbols cycle guard (F310)', () => {
  it('breaks cyclic DocumentSymbol children instead of overflowing the call stack', () => {
    const sym: Record<string, unknown> = {
      name: 'A',
      kind: 5,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    sym.children = [sym];

    const out = symbolsCoverage.formatSymbols([sym as never]);
    expect(out).toContain('A [5] line 1');
  });
});
