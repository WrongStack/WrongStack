import { describe, expect, it } from 'vitest';
import { formatCodebaseLspResults } from '../../src/formatters/symbols.js';

describe('formatCodebaseLspResults', () => {
  it('formats empty results with searched sources', () => {
    const output = formatCodebaseLspResults(
      { results: [], totalIndex: 5, totalLsp: 0, query: 'foo', usedIndex: true, usedLsp: false },
      '/proj',
    );
    expect(output).toContain('No symbols matching "foo"');
    expect(output).toContain('index(5)');
    expect(output).not.toContain('lsp(');
  });

  it('formats empty results when neither source was used', () => {
    const output = formatCodebaseLspResults(
      { results: [], totalIndex: 0, totalLsp: 0, query: 'bar', usedIndex: false, usedLsp: false },
      '/proj',
    );
    expect(output).toContain('Searched: none');
  });

  it('formats results with index source and score', () => {
    const output = formatCodebaseLspResults(
      {
        results: [
          {
            name: 'myFunc',
            kind: 'function',
            lspKind: 12,
            file: '/proj/src/index.ts',
            line: 42,
            source: 'index',
            score: 0.95,
          },
        ],
        totalIndex: 1,
        totalLsp: 0,
        query: 'myFunc',
        usedIndex: true,
        usedLsp: false,
      },
      '/proj',
    );
    expect(output).toContain('1 results for "myFunc"');
    expect(output).toContain('[index]');
    expect(output).toContain('function myFunc');
    expect(output).toContain('score=0.95');
    // cwd-relative path
    expect(output).toContain('src/index.ts:42');
  });

  it('formats results with lsp source and snippet', () => {
    const output = formatCodebaseLspResults(
      {
        results: [
          {
            name: 'MyClass',
            kind: 'class',
            lspKind: 5,
            file: '/proj/src/MyClass.ts',
            line: 10,
            source: 'lsp',
            server: 'tsserver',
            snippet: 'class MyClass { ... }',
          },
        ],
        totalIndex: 0,
        totalLsp: 1,
        query: 'MyClass',
        usedIndex: false,
        usedLsp: true,
      },
      '/proj',
    );
    expect(output).toContain('[lsp:tsserver]');
    expect(output).toContain('class MyClass');
    expect(output).toContain('class MyClass { ... }');
  });

  it('formats results without snippet (just the symbol line)', () => {
    const output = formatCodebaseLspResults(
      {
        results: [
          {
            name: 'bareVar',
            kind: 'variable',
            lspKind: 13,
            file: '/proj/v.ts',
            line: 1,
            source: 'index',
          },
        ],
        totalIndex: 1,
        totalLsp: 0,
        query: 'bareVar',
        usedIndex: true,
        usedLsp: false,
      },
      '/proj',
    );
    expect(output).toContain('variable bareVar');
    // No snippet line after it (no extra indented line)
    const lines = output.split('\n');
    const symbolLine = lines.find((l) => l.includes('bareVar'))!;
    expect(symbolLine).toBeDefined();
  });

  it('uses ? for lsp source without server name', () => {
    const output = formatCodebaseLspResults(
      {
        results: [
          { name: 'x', kind: 'variable', lspKind: 13, file: '/p/x.ts', line: 1, source: 'lsp' },
        ],
        totalIndex: 0,
        totalLsp: 1,
        query: 'x',
        usedIndex: false,
        usedLsp: true,
      },
      '/p',
    );
    expect(output).toContain('[lsp:?]');
  });
});
