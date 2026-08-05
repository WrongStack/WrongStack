import { describe, expect, it } from 'vitest';
import { parseSymbols } from '../src/codebase-index/rs-parser.js';

// The parser is pure: it spawns nothing, so there is no toolchain to mock.
// Rust dependency edges come from `use`/`mod` via the import extractor and are
// covered in codebase-index-multilang-relations.test.ts.

const parse = (content: string, file = 'lib.rs') => parseSymbols({ file, content, lang: 'rs' });
const find = async (content: string, name: string) =>
  (await parse(content)).symbols.find((s) => s.name === name);

describe('rs-parser', () => {
  it('extracts every Rust declaration kind', async () => {
    const content = [
      'fn do_thing(a: i32) {}',
      'struct Point {}',
      'enum Color {}',
      'trait Draw {}',
      'impl Point {}',
      'type Alias = i32;',
      'const MAX: i32 = 1;',
      'static GLOBAL: i32 = 2;',
      'mod utils {}',
    ].join('\n');
    expect((await find(content, 'do_thing'))?.kind).toBe('function');
    expect((await find(content, 'Point'))?.kind).toBe('struct');
    expect((await find(content, 'Color'))?.kind).toBe('enum');
    expect((await find(content, 'Draw'))?.kind).toBe('trait');
    expect((await find(content, 'Alias'))?.kind).toBe('type');
    expect((await find(content, 'MAX'))?.kind).toBe('const');
    expect((await find(content, 'GLOBAL'))?.kind).toBe('static');
    expect((await find(content, 'utils'))?.kind).toBe('mod');
  });

  it('classifies an impl block as kind "impl"', async () => {
    // Name distinct from any struct/enum so dedup-by-name doesn't mask the impl.
    expect((await find('impl Renderer {}', 'Renderer'))?.kind).toBe('impl');
  });

  it('deduplicates symbols sharing name + line', async () => {
    // Two `fn foo` on the same physical line → one survives after dedup.
    const res = await parse('fn foo() {} fn foo() {}');
    expect(res.symbols.filter((s) => s.name === 'foo')).toHaveLength(1);
  });

  it('never executes or writes to the scanned project', async () => {
    // Regression guard for the removed native path: it resolved a cargo
    // subproject from process.cwd() — the *indexed* repository — so a scan
    // target containing tools/Cargo.toml would have had its build run and its
    // working tree written to. Indexing reads a repository; nothing more.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/codebase-index/rs-parser.ts', import.meta.url),
      'utf8',
    );
    // Comments stripped first — the file documents *why* the native path is
    // gone, and that prose names the very APIs this guard forbids.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.cwd\(\)/);
    expect(code).not.toMatch(/child_process/);
    expect(code).not.toMatch(/\bspawn\(/);
  });
});
