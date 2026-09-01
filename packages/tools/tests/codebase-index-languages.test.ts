import { describe, expect, it } from 'vitest';
import {
  GENERIC_MAX_FILE_CHARS,
  GENERIC_MAX_SYMBOLS_DEFAULT,
  parseGeneric,
} from '../src/codebase-index/generic-parser.js';
import {
  detectLang,
  INDEXABLE_EXTENSIONS,
  isIndexablePath,
} from '../src/codebase-index/languages.js';

describe('languages map', () => {
  it('maps first-class and extended languages', () => {
    expect(detectLang('a.ts')).toBe('ts');
    expect(detectLang('a.mts')).toBe('ts');
    expect(detectLang('a.cts')).toBe('ts');
    expect(detectLang('a.mjs')).toBe('js');
    expect(detectLang('a.cjs')).toBe('js');
    expect(detectLang('a.py')).toBe('py');
    expect(detectLang('a.pyi')).toBe('py');
    expect(detectLang('Foo.java')).toBe('java');
    expect(detectLang('lib.cpp')).toBe('cpp');
    expect(detectLang('Main.cs')).toBe('csharp');
    expect(detectLang('app.rb')).toBe('ruby');
    expect(detectLang('run.sh')).toBe('shell');
    expect(detectLang('schema.sql')).toBe('sql');
    expect(detectLang('README.md')).toBe('md');
    expect(detectLang('Cargo.toml')).toBe('toml');
    expect(detectLang('page.vue')).toBe('vue');
    expect(detectLang('svc.proto')).toBe('proto');
    expect(detectLang('foo.d.ts')).toBe('ts');
  });

  it('indexes special basenames', () => {
    expect(detectLang('Makefile')).toBe('other');
    expect(detectLang('Dockerfile')).toBe('other');
    expect(detectLang('Gemfile')).toBe('ruby');
    expect(isIndexablePath('/repo/Makefile')).toBe(true);
  });

  it('still rejects plain non-source assets', () => {
    expect(detectLang('notes.txt')).toBeNull();
    expect(detectLang('photo.png')).toBeNull();
    expect(detectLang('archive')).toBeNull();
    expect(isIndexablePath('notes.txt')).toBe(false);
  });

  it('exposes a non-empty extension allow-list used by discovery', () => {
    expect(INDEXABLE_EXTENSIONS).toContain('.ts');
    expect(INDEXABLE_EXTENSIONS).toContain('.java');
    expect(INDEXABLE_EXTENSIONS).toContain('.py');
    expect(INDEXABLE_EXTENSIONS.length).toBeGreaterThan(30);
  });
});

describe('generic parser coverage', () => {
  it('extracts Python symbols without a runtime', () => {
    const res = parseGeneric({
      file: 'm.py',
      lang: 'py',
      content: ['class Widget:', '    pass', '', 'def build():', '    return 1'].join('\n'),
    });
    expect(res.symbols.map((s) => s.name).sort()).toEqual(['Widget', 'build'].sort());
  });

  it('extracts Java class and method-like names', () => {
    const res = parseGeneric({
      file: 'A.java',
      lang: 'java',
      content: `
public class Hello {
  public static void main(String[] args) {}
  private int compute(int x) { return x; }
}
`,
    });
    expect(res.symbols.some((s) => s.name === 'Hello')).toBe(true);
    expect(res.symbols.some((s) => s.name === 'main' || s.name === 'compute')).toBe(true);
  });

  it('extracts shell functions', () => {
    const res = parseGeneric({
      file: 'x.sh',
      lang: 'shell',
      content: 'deploy() {\n  echo hi\n}\nfunction cleanup() {\n  rm -rf /tmp/x\n}\n',
    });
    expect(res.symbols.map((s) => s.name).sort()).toEqual(['cleanup', 'deploy'].sort());
  });

  it('extracts markdown headings', () => {
    const res = parseGeneric({
      file: 'R.md',
      lang: 'md',
      content: '# Title\n\n## Section\n\nbody\n',
    });
    expect(res.symbols.map((s) => s.name)).toEqual(expect.arrayContaining(['Title', 'Section']));
  });

  it('skips binary-looking content', () => {
    const res = parseGeneric({
      file: 'x.bin',
      lang: 'other',
      content: `abc\0def function foo() {}`,
    });
    expect(res.symbols).toEqual([]);
  });

  it('never throws on empty input', () => {
    expect(() => parseGeneric({ file: 'x', lang: 'other', content: '' })).not.toThrow();
  });

  it('caps symbol count and only scans a leading window of huge files', () => {
    const many = Array.from({ length: 2000 }, (_, i) => `def fn_${i}():\n  pass\n`).join('');
    const res = parseGeneric({ file: 'huge.py', lang: 'py', content: many });
    expect(res.symbols.length).toBeLessThanOrEqual(GENERIC_MAX_SYMBOLS_DEFAULT);
    expect(GENERIC_MAX_FILE_CHARS).toBe(128 * 1024);
  });
});
