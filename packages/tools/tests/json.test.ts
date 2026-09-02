import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { jsonTool as rawJsonTool } from '../src/json.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'json-tool-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// Minimal tool Context. projectRoot is pinned to tmpDir so reads of files
// created under tmpDir pass safeResolveReal's containment check.
const makeCtx = () =>
  ({ cwd: tmpDir, workingDir: tmpDir, tools: [], projectRoot: tmpDir }) as never;

const jsonTool = {
  ...rawJsonTool,
  execute: (
    args: Parameters<typeof rawJsonTool.execute>[0],
    context: Parameters<typeof rawJsonTool.execute>[1] = makeCtx(),
    options: Parameters<typeof rawJsonTool.execute>[2] = {
      signal: new AbortController().signal,
    },
  ) => rawJsonTool.execute(args, context, options),
};

describe('jsonTool', () => {
  it('has correct metadata', () => {
    expect(jsonTool.name).toBe('json');
    expect(jsonTool.permission).toBe('auto');
    expect(jsonTool.mutating).toBe(false);
  });

  it('returns error when no file or data provided', async () => {
    const result = await jsonTool.execute({});
    expect(result.error).toBe('Provide file or data');
  });

  it('parses valid JSON from data', async () => {
    const result = await jsonTool.execute({ data: '{"foo":123}' });
    expect(result.data).toEqual({ foo: 123 });
    expect(result.type).toBe('object');
    expect(result.error).toBeUndefined();
  });

  it('returns parse error for invalid JSON', async () => {
    const result = await jsonTool.execute({ data: '{invalid}' });
    expect(result.error).toContain('Parse failed');
    expect(result.data).toBeNull();
  });

  it('reads from file', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.json'), '{"a":1}', 'utf8');
    const result = await jsonTool.execute({ file: path.join(tmpDir, 'test.json') }, makeCtx());
    expect(result.data).toEqual({ a: 1 });
  });

  it('returns error for non-existent file', async () => {
    const result = await jsonTool.execute({ file: '/nonexistent.json' }, makeCtx());
    expect(result.error).toContain('Could not read file');
  });

  it('extracts keys', async () => {
    const result = await jsonTool.execute({ data: '{"foo":1,"bar":2}' });
    expect(result.keys).toContain('foo');
    expect(result.keys).toContain('bar');
  });

  it('handles array type', async () => {
    const result = await jsonTool.execute({ data: '[1,2,3]' });
    expect(result.type).toBe('array');
    expect(result.data).toEqual([1, 2, 3]);
  });

  it('validates without full output', async () => {
    const result = await jsonTool.execute({ data: '{"valid":true}', validate: true });
    expect(result.formatted).toBe('valid');
  });

  it('queries nested paths (backward compat — simple path query)', async () => {
    const result = await jsonTool.execute({ data: '{"a":{"b":[1,2,3]}}', query: 'a.b[0]' });
    expect(result.query_result).toBe(1);
  });

  it('queries array index (backward compat)', async () => {
    const result = await jsonTool.execute({ data: '[10,20,30]', query: '1' });
    expect(result.query_result).toBe(20);
  });

  it('returns undefined for missing query path', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', query: 'b.c' });
    expect(result.query_result).toBeUndefined();
  });

  it('outputs as json5 format', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', format: 'json5' });
    expect(result.formatted).toBe('{\n  "a": 1\n}');
  });

  it('outputs as yaml format', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', format: 'yaml' });
    expect(result.formatted).toContain('a:');
  });

  it('handles array in yaml', async () => {
    const result = await jsonTool.execute({ data: '[1,2,3]', format: 'yaml' });
    expect(result.formatted).toContain('- 1');
  });

  it('returns undefined when a query descends into a scalar', async () => {
    const result = await jsonTool.execute({ data: '{"a":1}', query: 'a.b' });
    expect(result.query_result).toBeUndefined();
  });

  it('quotes yaml string values that contain special characters', async () => {
    const result = await jsonTool.execute({ data: '{"a":"x:y"}', format: 'yaml' });
    expect(result.formatted).toContain('"x:y"');
  });

  it('emits plain yaml string values without quoting', async () => {
    const result = await jsonTool.execute({ data: '{"a":"plain"}', format: 'yaml' });
    expect(result.formatted).toContain('a: plain');
  });

  it('renders an empty array in yaml', async () => {
    const result = await jsonTool.execute({ data: '[]', format: 'yaml' });
    expect(result.formatted).toContain('[]');
  });

  it('renders null and boolean values in yaml', async () => {
    const result = await jsonTool.execute({ data: '{"n":null,"b":true}', format: 'yaml' });
    expect(result.formatted).toContain('n: null');
    expect(result.formatted).toContain('b: true');
  });
});

// ---------------------------------------------------------------------------
// action: query (JMESPath — consolidated from json-path plugin)
// ---------------------------------------------------------------------------

describe('jsonTool action: query', () => {
  it('returns the whole document for @', async () => {
    const data = { a: 1 };
    const result = await jsonTool.execute({
      action: 'query',
      data: JSON.stringify(data),
      query: '@',
    });
    expect(result.query_result).toEqual(data);
  });

  it('resolves dot notation and nested keys', async () => {
    const result = await jsonTool.execute({ action: 'query', data: '{"a":{"b":2}}', query: 'a.b' });
    expect(result.query_result).toBe(2);
  });

  it('resolves array indexing', async () => {
    const r1 = await jsonTool.execute({ action: 'query', data: '[10,20]', query: '[0]' });
    expect(r1.query_result).toBe(10);
    const r2 = await jsonTool.execute({ action: 'query', data: '[{"x":5}]', query: '[0].x' });
    expect(r2.query_result).toBe(5);
  });

  it('handles multi-select projections', async () => {
    const result = await jsonTool.execute({
      action: 'query',
      data: '{"items":[{"v":1},{"v":2}]}',
      query: 'items[*].v',
    });
    expect(result.query_result).toEqual([1, 2]);
  });

  it('supports filter expressions', async () => {
    const result = await jsonTool.execute({
      action: 'query',
      data: '[{"n":1},{"n":2},{"n":3}]',
      query: '[n>`2`]',
    });
    expect(result.query_result).toEqual([{ n: 3 }]);
  });

  it('supports length/keys/values/type functions', async () => {
    const len = await jsonTool.execute({ action: 'query', data: '[1,2,3]', query: 'length(@)' });
    expect(len.query_result).toBe(3);
    const keys = await jsonTool.execute({
      action: 'query',
      data: '{"a":1,"b":2}',
      query: 'keys(@)',
    });
    expect(keys.query_result).toEqual(['a', 'b']);
    const type = await jsonTool.execute({ action: 'query', data: 'null', query: 'type(@)' });
    expect(type.query_result).toBe('null');
  });

  it('returns error when query is missing', async () => {
    const result = await jsonTool.execute({ action: 'query', data: '{}' });
    expect(result.error).toContain('query is required');
  });
});

// ---------------------------------------------------------------------------
// action: validate (JSON Schema — consolidated from json-path plugin)
// ---------------------------------------------------------------------------

describe('jsonTool action: validate', () => {
  it('validates type matches', async () => {
    const result = await jsonTool.execute({
      action: 'validate',
      data: '5',
      schema: { type: 'integer' },
    });
    expect(result.valid).toBe(true);
  });

  it('reports type mismatches', async () => {
    const result = await jsonTool.execute({
      action: 'validate',
      data: '"x"',
      schema: { type: 'number' },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toMatch(/expected number/);
  });

  it('validates uri format', async () => {
    const ok = await jsonTool.execute({
      action: 'validate',
      data: '"https://example.com"',
      schema: { type: 'string', format: 'uri' },
    });
    expect(ok.valid).toBe(true);
    const bad = await jsonTool.execute({
      action: 'validate',
      data: '":::bad"',
      schema: { type: 'string', format: 'uri' },
    });
    expect(bad.valid).toBe(false);
  });

  it('validates nested object properties', async () => {
    const result = await jsonTool.execute({
      action: 'validate',
      data: '{"a":"x"}',
      schema: { type: 'object', properties: { a: { type: 'number' } } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors?.some((e) => e.includes('$.a'))).toBe(true);
  });

  it('validates array items when items is an object schema', async () => {
    const ok = await jsonTool.execute({
      action: 'validate',
      data: '["hello", "world"]',
      schema: { type: 'array', items: { type: 'string' } },
    });
    expect(ok.valid).toBe(true);

    const bad = await jsonTool.execute({
      action: 'validate',
      data: '["hello", 123]',
      schema: { type: 'array', items: { type: 'string' } },
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors?.some((e) => e.includes('expected string'))).toBe(true);
  });

  it('validates required object fields', async () => {
    const ok = await jsonTool.execute({
      action: 'validate',
      data: '{"name": "Alice", "age": 30}',
      schema: { type: 'object', required: ['name', 'age'] },
    });
    expect(ok.valid).toBe(true);

    const bad = await jsonTool.execute({
      action: 'validate',
      data: '{"name": "Alice"}',
      schema: { type: 'object', required: ['name', 'age'] },
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors?.some((e) => e.includes('missing required property "age"'))).toBe(true);
  });

  it('returns error when schema is missing', async () => {
    const result = await jsonTool.execute({ action: 'validate', data: '{}' });
    expect(result.error).toContain('schema is required');
  });

  // Security scan 2026-08-04, finding M4. `schema.pattern` reached a bare
  // `new RegExp` — an LLM-supplied pattern evaluated against file content on an
  // engine the executor's timeout cannot interrupt. Every other user-regex site
  // in this package already routed through `compileUserRegex`; this one didn't.
  describe('schema.pattern is compiled through the ReDoS guard (M4)', () => {
    it('still validates an ordinary pattern', async () => {
      const ok = await jsonTool.execute({
        action: 'validate',
        data: '"abc-123"',
        schema: { type: 'string', pattern: '^[a-z]+-\\d+$' },
      });
      expect(ok.valid).toBe(true);

      const bad = await jsonTool.execute({
        action: 'validate',
        data: '"nope"',
        schema: { type: 'string', pattern: '^[a-z]+-\\d+$' },
      });
      expect(bad.valid).toBe(false);
      expect(bad.errors?.some((e) => e.includes('does not match pattern'))).toBe(true);
    });

    it('refuses a catastrophic-backtracking pattern instead of running it', async () => {
      const result = await jsonTool.execute({
        action: 'validate',
        data: `"${'a'.repeat(200)}"`,
        schema: { type: 'string', pattern: '(a+)+$' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes('invalid schema pattern'))).toBe(true);
    });

    it('refuses an over-long pattern', async () => {
      const result = await jsonTool.execute({
        action: 'validate',
        data: '"x"',
        schema: { type: 'string', pattern: `^${'a'.repeat(300)}$` },
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes('invalid schema pattern'))).toBe(true);
    });

    it('reports a malformed pattern as an error rather than throwing', async () => {
      // Previously `new RegExp('(unclosed')` threw straight out of validate.
      const result = await jsonTool.execute({
        action: 'validate',
        data: '"x"',
        schema: { type: 'string', pattern: '(unclosed' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors?.some((e) => e.includes('invalid schema pattern'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// action: transform (chained JMESPath — consolidated from json-path plugin)
// ---------------------------------------------------------------------------

describe('jsonTool action: transform', () => {
  it('applies transforms in sequence', async () => {
    const result = await jsonTool.execute({
      action: 'transform',
      data: '{"items":[{"v":1},{"v":2}]}',
      transforms: ['items[*].v', 'length(@)'],
    });
    expect(result.result).toBe(2);
    expect(result.steps?.length).toBe(2);
  });

  it('returns error when transforms is missing', async () => {
    const result = await jsonTool.execute({ action: 'transform', data: '{}' });
    expect(result.error).toContain('transforms array is required');
  });
});

// ---------------------------------------------------------------------------
// action: merge (deep merge — consolidated from json-path plugin)
// ---------------------------------------------------------------------------

describe('jsonTool action: merge', () => {
  it('deep-merges nested objects (patch wins on scalar collisions)', async () => {
    const result = await jsonTool.execute({
      action: 'merge',
      base: { a: 1, nested: { x: 1 } },
      patch: { a: 2, nested: { y: 2 } },
    });
    expect(result.result).toEqual({ a: 2, nested: { x: 1, y: 2 } });
  });

  it('merges disjoint keys', async () => {
    const result = await jsonTool.execute({ action: 'merge', base: { a: 1 }, patch: { b: 2 } });
    expect(result.result).toEqual({ a: 1, b: 2 });
  });

  it('prefer-base keeps the base for a scalar collision', async () => {
    const result = await jsonTool.execute({
      action: 'merge',
      base: 5,
      patch: 10,
      conflictResolution: 'prefer-base',
    });
    expect(result.result).toBe(5);
  });

  it('prefer-patch (default) takes the patch for a scalar collision', async () => {
    const result = await jsonTool.execute({ action: 'merge', base: 5, patch: 10 });
    expect(result.result).toBe(10);
  });

  it('returns error when base or patch is missing', async () => {
    const result = await jsonTool.execute({ action: 'merge', base: {} });
    expect(result.error).toContain('base and patch are required');
  });

  describe('path containment (CWE-22)', () => {
    it('blocks reading a real file that sits outside the pinned project root', async () => {
      // Create a genuinely readable JSON file in tmpDir, then pin projectRoot
      // to a *subdirectory* so the file is provably outside the root. Without
      // safeResolveReal the read would succeed and leak the file's contents.
      const secret = path.join(tmpDir, 'outside.json');
      await fs.writeFile(secret, '{"secret":42}', 'utf8');
      const sub = path.join(tmpDir, 'sub');
      await fs.mkdir(sub, { recursive: true });

      const result = await jsonTool.execute({ file: secret }, {
        cwd: sub,
        workingDir: sub,
        tools: [],
        projectRoot: sub,
      } as never);
      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });

    it('blocks a ../ traversal escape for the query action', async () => {
      const result = await jsonTool.execute(
        { action: 'query', file: '../../../../etc/passwd', query: 'a' },
        { cwd: tmpDir, workingDir: tmpDir, tools: [], projectRoot: tmpDir } as never,
      );
      expect(result.data).toBeNull();
      expect(result.error).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// RAM guard: files exceeding the size cap must be rejected before read+parse
// ---------------------------------------------------------------------------

describe('jsonTool RAM guard (file-size cap)', () => {
  it('parse action rejects a file exceeding the size limit', async () => {
    // 17 MiB of whitespace-padded JSON — over the 16 MiB cap
    const big = '{"x":"' + ' '.repeat(17 * 1024 * 1024) + '"}';
    const filePath = path.join(tmpDir, 'big.json');
    await fs.writeFile(filePath, big, 'utf8');
    const result = await jsonTool.execute({ file: filePath }, makeCtx());
    expect(result.data).toBeNull();
    expect(result.error).toContain('exceeds the');
    expect(result.error).toContain('16 MiB');
  });

  it('query action rejects a file exceeding the size limit', async () => {
    const big = '{"x":"' + ' '.repeat(17 * 1024 * 1024) + '"}';
    const filePath = path.join(tmpDir, 'big-query.json');
    await fs.writeFile(filePath, big, 'utf8');
    const result = await jsonTool.execute(
      { action: 'query', file: filePath, query: 'x' },
      makeCtx(),
    );
    expect(result.data).toBeNull();
    expect(result.error).toContain('exceeds the');
  });

  it('validate action rejects a file exceeding the size limit', async () => {
    const big = '{"x":"' + ' '.repeat(17 * 1024 * 1024) + '"}';
    const filePath = path.join(tmpDir, 'big-validate.json');
    await fs.writeFile(filePath, big, 'utf8');
    const result = await jsonTool.execute(
      { action: 'validate', file: filePath, schema: { type: 'object' } },
      makeCtx(),
    );
    expect(result.data).toBeNull();
    expect(result.error).toContain('exceeds the');
  });

  it('transform action rejects a file exceeding the size limit', async () => {
    const big = '{"x":"' + ' '.repeat(17 * 1024 * 1024) + '"}';
    const filePath = path.join(tmpDir, 'big-transform.json');
    await fs.writeFile(filePath, big, 'utf8');
    const result = await jsonTool.execute(
      { action: 'transform', file: filePath, transforms: ['x'] },
      makeCtx(),
    );
    expect(result.data).toBeNull();
    expect(result.error).toContain('exceeds the');
  });

  it('parse action succeeds on a file just under the size limit', async () => {
    // ~1 KB — well within the cap, verifies normal path is unaffected
    const filePath = path.join(tmpDir, 'small.json');
    await fs.writeFile(filePath, '{"ok":true}', 'utf8');
    const result = await jsonTool.execute({ file: filePath }, makeCtx());
    expect(result.data).toEqual({ ok: true });
  });
});
