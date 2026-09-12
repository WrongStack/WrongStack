import { describe, expect, it } from 'vitest';
import { parseSymbols } from '../src/codebase-index/go-parser.js';

const parse = (content: string, file = 'main.go') => parseSymbols({ file, content, lang: 'go' });

describe('go-parser parseSymbols', () => {
  it('extracts symbols from Go source', async () => {
    const res = await parse(
      [
        'package main',
        'const Version = "1"',
        'type Widget struct { Name string }',
        'func Main() {}',
      ].join('\n'),
    );

    expect(res.file).toBe('main.go');
    expect(res.symbols.find((s) => s.name === 'Main')?.kind).toBe('function');
    expect(res.symbols.find((s) => s.name === 'Widget')?.kind).toBe('type');
    expect(res.symbols.find((s) => s.name === 'Version')?.kind).toBe('const');
  });

  it('returns no symbols for invalid Go source', async () => {
    const res = await parse('package main\nfunc {');
    expect(res.symbols).toEqual([]);
    expect(res.file).toBe('main.go');
  });

  it('reports 0-based columns per schema (go token.Column is 1-based)', async () => {
    const res = await parse(['package main', 'func Main() {}'].join('\n'));
    const fn = res.symbols.find((s) => s.name === 'Main');
    expect(fn).toBeDefined();
    expect(fn?.line).toBe(2);
    expect(fn?.col).toBe(0);
  });
});
