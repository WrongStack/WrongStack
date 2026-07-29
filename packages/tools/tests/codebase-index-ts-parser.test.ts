import { describe, expect, it } from 'vitest';
import { detectLang, parseSymbols } from '../src/codebase-index/ts-parser.js';

const parse = async (content: string, file = 'src.ts', lang = 'ts' as const) =>
  parseSymbols({ file, content, lang });
const kindByName = async (content: string, name: string, file = 'src.ts') =>
  (await parse(content, file)).symbols.find((s) => s.name === name)?.kind;

describe('ts-parser parseSymbols — declaration kinds', () => {
  it('classifies classes, interfaces, enums, type aliases, functions', async () => {
    const content = [
      'export class Foo {}',
      'interface Bar {}',
      'enum Color { Red }',
      'type Alias = number;',
      'function fn() {}',
    ].join('\n');
    expect(await kindByName(content, 'Foo')).toBe('class');
    expect(await kindByName(content, 'Bar')).toBe('interface');
    expect(await kindByName(content, 'Color')).toBe('enum');
    expect(await kindByName(content, 'Alias')).toBe('type');
    expect(await kindByName(content, 'fn')).toBe('function');
  });

  it('distinguishes const, let, and var declarations', async () => {
    const content = ['const a = 1;', 'let b = 2;', 'var c = 3;'].join('\n');
    expect(await kindByName(content, 'a')).toBe('const');
    expect(await kindByName(content, 'b')).toBe('let');
    expect(await kindByName(content, 'c')).toBe('var');
  });

  it('classifies methods, accessors, and properties inside a class', async () => {
    const content = [
      'class K {',
      '  prop = 1;',
      '  method() {}',
      '  get value() { return 1; }',
      '  set value(v: number) {}',
      '}',
    ].join('\n');
    expect(await kindByName(content, 'prop')).toBe('property');
    expect(await kindByName(content, 'method')).toBe('method');
    expect(await kindByName(content, 'value')).toBe('property');
  });

  it('classifies namespace/module declarations', async () => {
    expect(await kindByName('namespace NS { export const x = 1; }', 'NS')).toBe('namespace');
  });

  it('skips anonymous default-exported classes (no identifier name → not recursed)', async () => {
    const content = ['export default class {', '  doIt() {}', '}'].join('\n');
    const syms = (await parse(content)).symbols;
    // The anonymous class is skipped, and the early return means its members
    // are not visited either.
    expect(syms.some((s) => s.kind === 'class')).toBe(false);
    expect(syms.some((s) => s.name === 'doIt')).toBe(false);
  });

  it('skips members with computed (non-identifier) names', async () => {
    const content = ['class C {', "  ['computed']() {}", '}'].join('\n');
    expect((await parse(content)).symbols.some((s) => s.kind === 'method')).toBe(false);
  });

  it('builds dotted scope for nested functions and class methods', async () => {
    const m = (await parse(['class Outer {', '  doThing() {}', '}'].join('\n'))).symbols.find(
      (s) => s.name === 'doThing',
    );
    expect(m?.scope).toBe('Outer');
  });
});

describe('ts-parser — JSDoc extraction', () => {
  it('captures the first line of a leading JSDoc comment', async () => {
    const content = [
      '/**',
      ' * Adds two numbers.',
      ' * @param a first',
      ' */',
      'function add(a: number) {}',
    ].join('\n');
    expect((await parse(content)).symbols.find((s) => s.name === 'add')?.docComment).toBe(
      'Adds two numbers.',
    );
  });

  it('returns no docComment for a plain (non-JSDoc) comment', async () => {
    const content = ['// just a line comment', 'function plain() {}'].join('\n');
    expect((await parse(content)).symbols.find((s) => s.name === 'plain')?.docComment).toBe('');
  });

  it('returns no docComment when there is no leading comment', async () => {
    expect(
      (await parse('function bare() {}')).symbols.find((s) => s.name === 'bare')?.docComment,
    ).toBe('');
  });
});

describe('ts-parser — reference extraction', () => {
  it('collects call, property-access, type, inherit, implement, and import refs', async () => {
    const content = [
      "import { x } from './dep.js';",
      'interface I {}',
      'class Base {}',
      'class Derived extends Base implements I {',
      '  run(): I {',
      '    helper();',
      '    obj.method();',
      '    return null as never as I;',
      '  }',
      '}',
      'function helper() {}',
    ].join('\n');
    const refs = (await parse(content)).refs ?? [];
    const has = (callType: string, toName: string) =>
      refs.some((r) => r.callType === callType && r.toName === toName);
    expect(has('import', 'x')).toBe(true); // import { x } → toName is 'x', not module path
    expect(has('call', 'helper')).toBe(true);
    expect(has('call', 'obj')).toBe(true); // property access on identifier `obj`
    expect(has('inherit', 'Base')).toBe(true);
    expect(has('implement', 'I')).toBe(true);
    expect(has('type_ref', 'I')).toBe(true);
  });

  it('handles qualified type names (ns.Type)', async () => {
    const content = ['namespace ns { export interface T {} }', 'let v: ns.T;'].join('\n');
    const refs = (await parse(content)).refs ?? [];
    expect(refs.some((r) => r.callType === 'type_ref' && r.toName === 'ns.T')).toBe(true);
  });

  it('deduplicates identical refs on the same line', async () => {
    const refs = (await parse('foo(); foo();')).refs ?? [];
    expect(refs.filter((r) => r.toName === 'foo' && r.callType === 'call')).toHaveLength(1);
  });
});

describe('ts-parser — detectLang', () => {
  it('maps known extensions to languages', async () => {
    expect(detectLang('a.ts')).toBe('ts');
    expect(detectLang('a.tsx')).toBe('tsx');
    expect(detectLang('a.js')).toBe('js');
    expect(detectLang('a.jsx')).toBe('jsx');
    expect(detectLang('a.go')).toBe('go');
    expect(detectLang('a.py')).toBe('py');
    expect(detectLang('a.rs')).toBe('rs');
    expect(detectLang('a.json')).toBe('json');
    expect(detectLang('a.yaml')).toBe('yaml');
    expect(detectLang('a.yml')).toBe('yaml');
  });

  it('returns null for non-source assets; special basenames are indexable', async () => {
    expect(detectLang('a.txt')).toBeNull();
    // Makefile/Dockerfile etc. are intentionally indexed as `other` via the
    // central languages map so monorepo build scripts enter the index.
    expect(detectLang('Makefile')).toBe('other');
  });

  it('produces a stable FileSymbols shape', async () => {
    const res = await parse('const z = 1;');
    expect(res.file).toBe('src.ts');
    expect(res.lang).toBe('ts');
    expect(typeof res.mtimeMs).toBe('number');
  });
});
