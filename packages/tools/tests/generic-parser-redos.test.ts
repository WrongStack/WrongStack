import { describe, expect, it } from 'vitest';
import { parseGeneric } from '../src/codebase-index/generic-parser.js';

// H-10 (security report VF-11): the java/csharp/C_LIKE method patterns had
// three adjacent quantifiers that could each consume whitespace — measured
// 4.5 s at 516 bytes and 42 s at 800 bytes of padding, reachable from any
// file in an indexed repo via the tree-sitter zero-symbol fallback. The
// rewritten patterns own whitespace exactly once, so a whitespace bomb now
// parses in linear time. These tests would hang (vitest timeout) on the old
// regexes — that hang IS the regression signal.
describe('generic-parser ReDoS bounds (H-10 / VF-11)', () => {
  it('returns promptly on whitespace-padded java', () => {
    const bomb = `${' '.repeat(20_000)}x`;
    const result = parseGeneric({ file: 'Bomb.java', content: bomb, lang: 'java' });
    expect(result.symbols).toEqual([]);
  });

  it('returns promptly on whitespace-padded csharp', () => {
    const bomb = `${' '.repeat(20_000)}y`;
    const result = parseGeneric({ file: 'Bomb.cs', content: bomb, lang: 'csharp' });
    expect(result.symbols).toEqual([]);
  });

  it('returns promptly on whitespace-padded c (C_LIKE patterns)', () => {
    const bomb = `${' '.repeat(20_000)}z;`;
    const result = parseGeneric({ file: 'bomb.c', content: bomb, lang: 'c' });
    expect(result.symbols).toEqual([]);
  });

  it('still detects java/csharp methods (modifiers + unspaced generics)', () => {
    const java = parseGeneric({
      file: 'Svc.java',
      content: 'public Map<String,Integer> parse(String in) {\n  return null;\n}\n',
      lang: 'java',
    });
    expect(java.symbols.map((s) => s.name)).toContain('parse');

    const cs = parseGeneric({
      file: 'Svc.cs',
      content: 'public int ComputeTotal(int a) {\n  return a;\n}\n',
      lang: 'csharp',
    });
    expect(cs.symbols.map((s) => s.name)).toContain('ComputeTotal');
  });
});
