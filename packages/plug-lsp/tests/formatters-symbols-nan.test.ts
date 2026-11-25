import { describe, expect, it } from 'vitest';
import { formatCodebaseLspResults } from '../src/formatters/symbols.js';

describe('formatCodebaseLspResults non-finite score', () => {
  it('omits score tag when score is NaN or Infinity', () => {
    const out = formatCodebaseLspResults(
      {
        results: [
          {
            name: 'foo',
            kind: 'function',
            lspKind: 12,
            file: '/repo/a.ts',
            line: 1,
            source: 'index',
            score: Number.NaN,
          },
        ],
        totalIndex: 1,
        totalLsp: 0,
        query: 'foo',
        usedIndex: true,
        usedLsp: false,
      },
      '/repo',
    );
    expect(out).not.toContain('score=');
    expect(out).not.toContain('NaN');
  });
});
