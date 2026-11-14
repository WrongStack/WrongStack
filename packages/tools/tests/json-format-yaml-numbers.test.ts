// Regression: `format: 'yaml'` must not turn a JSON number into text.
//
// `String(n)` is not YAML for the non-finite doubles — it produces the bare
// words `Infinity` / `-Infinity` / `NaN`, and YAML resolves none of them as a
// number (the core-schema spellings are `.inf` / `-.inf` / `.nan`), so an
// overflowed JSON number (`{"big":1e999}`, whose strict-JSON parse products is
// really Infinity) reached whoever reads `formatted` as the STRING "Infinity".
import { describe, expect, it } from 'vitest';
import { jsonTool as rawJsonTool } from '../src/json.js';
import { formatOutput } from '../src/json-format.js';

const jsonTool = {
  ...rawJsonTool,
  execute: (
    args: Parameters<typeof rawJsonTool.execute>[0],
    context: Parameters<typeof rawJsonTool.execute>[1] = { tools: [] } as never,
    options: Parameters<typeof rawJsonTool.execute>[2] = {
      signal: new AbortController().signal,
    },
  ) => rawJsonTool.execute(args, context, options),
};

describe('formatOutput yaml — non-finite numbers', () => {
  it('renders Infinity as the YAML float spelling, not the bare word', () => {
    expect(formatOutput({ big: JSON.parse('1e999') as number }, 'yaml')).toBe('big: .inf\n');
  });

  it('renders -Infinity as the YAML float spelling', () => {
    expect(formatOutput({ deep: JSON.parse('-1e999') as number }, 'yaml')).toBe('deep: -.inf\n');
  });

  it('renders NaN as the YAML float spelling', () => {
    expect(formatOutput({ nan: Number.NaN }, 'yaml')).toBe('nan: .nan\n');
  });

  it('leaves finite numbers untouched, including exponential form', () => {
    expect(formatOutput({ int: 1, frac: 1.5, exp: 1e21, zero: 0 }, 'yaml')).toBe(
      'int: 1\nfrac: 1.5\nexp: 1e+21\nzero: 0\n',
    );
  });

  it('keeps the round-r12 string guards intact alongside numbers', () => {
    expect(
      formatOutput({ str: '123', truthy: 'true', big: Number.POSITIVE_INFINITY }, 'yaml'),
    ).toBe('str: "123"\ntruthy: "true"\nbig: .inf\n');
  });

  it('renders non-finite numbers inside arrays and nested objects', () => {
    expect(formatOutput({ list: [Number.POSITIVE_INFINITY, 2] }, 'yaml')).toBe(
      'list:\n  - .inf\n  - 2\n',
    );
    expect(formatOutput({ obj: { inner: Number.NEGATIVE_INFINITY } }, 'yaml')).toBe(
      'obj:\n  inner: -.inf\n',
    );
  });

  it('serves the same spelling through the json tool entry point', async () => {
    const result = await jsonTool.execute({
      action: 'parse',
      data: '{"big":1e999}',
      format: 'yaml',
    });
    expect(result.formatted).toBe('big: .inf\n');
  });

  it('breaks cyclic object references in YAML output instead of overflowing the stack (F301)', () => {
    const a: Record<string, unknown> = { ok: 1 };
    a['self'] = a;
    const yaml = formatOutput(a, 'yaml');
    expect(yaml).toContain('ok: 1');
    expect(yaml).toContain('[Circular]');
  });
});
