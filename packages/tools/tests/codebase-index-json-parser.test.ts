import { describe, expect, it } from 'vitest';
import { parseSymbols } from '../src/codebase-index/json-parser.js';

const parse = (file: string, content: string) => parseSymbols({ file, content, lang: 'json' });

const names = (file: string, content: string) => parse(file, content).symbols.map((s) => s.name);
const find = (file: string, content: string, name: string) =>
  parse(file, content).symbols.find((s) => s.name === name);

describe('json-parser parseSymbols', () => {
  it('emits a root object symbol and top-level keys as properties', () => {
    const content = '{\n  "name": "x",\n  "value": 1\n}';
    const res = parse('data.json', content);
    expect(res.symbols.find((s) => s.kind === 'object')?.name).toBe('data.json');
    expect(find('data.json', content, 'name')?.kind).toBe('property');
    expect(names('data.json', content)).toEqual(expect.arrayContaining(['name', 'value']));
  });

  it('marks package.json dependency blocks as const and scripts as functions', () => {
    const content = [
      '{',
      '  "name": "pkg",',
      '  "scripts": { "build": "tsc", "test": "vitest" },',
      '  "dependencies": { "a": "1" },',
      '  "devDependencies": { "b": "2" }',
      '}',
    ].join('\n');
    expect(find('package.json', content, 'dependencies')?.kind).toBe('const');
    expect(find('package.json', content, 'scripts')?.kind).toBe('const');
    // Individual scripts extracted as functions.
    expect(find('package.json', content, 'build')?.kind).toBe('function');
    expect(find('package.json', content, 'test')?.kind).toBe('function');
  });

  it('extracts tsconfig compilerOptions and its nested keys', () => {
    const content = [
      '{',
      '  "compilerOptions": {',
      '    "strict": true,',
      '    "target": "ES2023"',
      '  }',
      '}',
    ].join('\n');
    expect(find('tsconfig.json', content, 'compilerOptions')?.kind).toBe('property');
    expect(names('tsconfig.json', content)).toEqual(expect.arrayContaining(['strict', 'target']));
  });

  it('also recognises tsconfig.build.json', () => {
    const content = '{\n  "compilerOptions": { "noEmit": true }\n}';
    expect(find('tsconfig.build.json', content, 'compilerOptions')).toBeDefined();
  });

  it('flags JSON Schema $schema/$id/$ref keys as schema', () => {
    const content = [
      '{',
      '  "$schema": "https://json-schema.org/draft-07/schema",',
      '  "$id": "https://example.com/x",',
      '  "$ref": "#/$defs/Thing",',
      '  "$defs": { "Thing": {} }',
      '}',
    ].join('\n');
    expect(find('schema.json', content, '$schema')?.kind).toBe('schema');
    expect(find('schema.json', content, '$id')?.kind).toBe('schema');
    expect(find('schema.json', content, '$ref')?.kind).toBe('schema');
    expect(find('schema.json', content, '$defs')).toBeDefined();
  });

  it('extracts OpenAPI components and definitions', () => {
    const content = [
      '{',
      '  "openapi": "3.0.0",',
      '  "components": { "schemas": {} },',
      '  "definitions": { "X": {} }',
      '}',
    ].join('\n');
    const ns = names('openapi.json', content);
    expect(ns).toEqual(expect.arrayContaining(['components', 'definitions', 'schemas']));
  });

  it('returns an empty symbol list for content with no root object', () => {
    const res = parse('arr.json', '[1, 2, 3]');
    // No leading `{` → no root object symbol; top-level key regex finds none.
    expect(res.symbols.find((s) => s.kind === 'object')).toBeUndefined();
  });

  it('produces a stable FileSymbols shape', () => {
    const res = parse('x.json', '{"a":1}');
    expect(res.file).toBe('x.json');
    expect(res.lang).toBe('json');
    expect(typeof res.mtimeMs).toBe('number');
  });
});
