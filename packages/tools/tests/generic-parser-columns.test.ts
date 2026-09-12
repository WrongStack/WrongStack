import { describe, expect, it } from 'vitest';
import { parseGeneric } from '../src/codebase-index/generic-parser.js';

// schema.ts declares `col` 0-based; the TS/JSON/YAML parsers all emit
// 0-based. Guards the lineColAt off-by-one (round 7).
describe('generic-parser column base', () => {
  it('reports col 0 for a symbol at line start (first line)', () => {
    const res = parseGeneric({ file: 'a.py', content: 'def foo():\n    pass', lang: 'py' });
    const foo = res.symbols.find((s) => s.name === 'foo');
    expect(foo).toBeDefined();
    expect(foo?.line).toBe(1);
    expect(foo?.col).toBe(0);
  });

  it('reports col 0 for a symbol at line start (later line)', () => {
    const res = parseGeneric({
      file: 'a.py',
      content: 'x = 1\ndef bar():\n    pass',
      lang: 'py',
    });
    const bar = res.symbols.find((s) => s.name === 'bar');
    expect(bar).toBeDefined();
    expect(bar?.line).toBe(2);
    expect(bar?.col).toBe(0);
  });

  it('reports the match offset for an indented symbol', () => {
    const res = parseGeneric({
      file: 'a.py',
      content: 'class A:\n    def meth(self):\n        pass',
      lang: 'py',
    });
    const cls = res.symbols.find((s) => s.name === 'A');
    expect(cls).toMatchObject({ line: 1, col: 0 });
  });
});
